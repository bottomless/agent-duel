#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readFlag(env, name) {
  const value = env[name]?.trim();
  if (value && value !== "0" && value !== "1") {
    throw new Error(`${name} must be 0 or 1 when provided`);
  }
  return value === "1";
}

// The hosted Agent Duel control plane. A release build signs in to it unless both values are
// overridden. The public key only verifies sessions, so it is safe to publish.
const DEFAULT_CONTROL_PLANE_URL = "https://agent-duel-cloud.vercel.app";
const DEFAULT_SESSION_PUBLIC_KEY = "MCowBQYDK2VwAyEA761o9AYhsOdLYkE082hwxAbPEmsQvmaeZ/jWaWVce0Q=";

function resolveControlPlane(env, { byok, updatesEnabled }) {
  const controlPlaneUrl = env.PASEO_CONTROL_PLANE_URL?.trim().replace(/\/$/, "");
  const sessionPublicKey = env.PASEO_SESSION_PUBLIC_KEY?.trim();
  if (byok) {
    if (controlPlaneUrl || sessionPublicKey) {
      throw new Error(
        "PASEO_BYOK_BUILD=1 builds without a control plane; unset PASEO_CONTROL_PLANE_URL and PASEO_SESSION_PUBLIC_KEY",
      );
    }
    // The release feed serves the hosted build, which would replace this one on update.
    if (updatesEnabled) {
      throw new Error("PASEO_BYOK_BUILD=1 cannot be combined with PASEO_DESKTOP_UPDATES_ENABLED=1");
    }
    return { controlPlaneUrl: null, sessionPublicKey: null };
  }
  if (!controlPlaneUrl && !sessionPublicKey) {
    return {
      controlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
      sessionPublicKey: DEFAULT_SESSION_PUBLIC_KEY,
    };
  }
  // A URL paired with another control plane's key would reject every session, so override both.
  if (!controlPlaneUrl || !URL.canParse(controlPlaneUrl) || !sessionPublicKey) {
    throw new Error(
      "Set both PASEO_CONTROL_PLANE_URL and PASEO_SESSION_PUBLIC_KEY to use another control plane, or neither for the hosted one; set PASEO_BYOK_BUILD=1 for a bring-your-own-key build",
    );
  }
  return { controlPlaneUrl, sessionPublicKey };
}

export function resolveDeploymentConfig(env, detectedBuildSha) {
  const byok = readFlag(env, "PASEO_BYOK_BUILD");
  const updatesEnabled = readFlag(env, "PASEO_DESKTOP_UPDATES_ENABLED");
  const controlPlane = resolveControlPlane(env, { byok, updatesEnabled });
  const arenaBuildSha = env.OPENCODE_ARENA_BUILD_SHA?.trim() || detectedBuildSha;
  if (!/^[0-9a-f]{7,64}$/i.test(arenaBuildSha)) {
    throw new Error(
      "OPENCODE_ARENA_BUILD_SHA must be a Git commit SHA when the repository HEAD is unavailable",
    );
  }
  return { ...controlPlane, updatesEnabled, arenaBuildSha };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const desktopDir = path.resolve(scriptDir, "..");
  const repositoryDir = path.resolve(desktopDir, "../..");
  const gitHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const detectedBuildSha = typeof gitHead.stdout === "string" ? gitHead.stdout.trim() : "";
  const config = resolveDeploymentConfig(process.env, detectedBuildSha);
  const outputDir = path.resolve(desktopDir, "dist");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    path.join(outputDir, "deployment-config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}
