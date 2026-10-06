#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const LOCAL_MONGO_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function databaseNameForRoot(root) {
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 10);
  return `agent_arena_dev_${suffix}`;
}

export function validateArenaEnvironment(env) {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  if (!openRouterKey || openRouterKey.length < 20) {
    throw new Error("OPENROUTER_API_KEY is missing or invalid");
  }

  const rawUri = env.OPENCODE_ARENA_MONGODB_URI?.trim();
  let mongoUri;
  try {
    mongoUri = new URL(rawUri);
  } catch {
    throw new Error("OPENCODE_ARENA_MONGODB_URI is missing or invalid");
  }
  if (mongoUri.protocol !== "mongodb:" || !LOCAL_MONGO_HOSTS.has(mongoUri.hostname)) {
    throw new Error("Desktop development requires a local mongodb:// URI");
  }

  const mongoPort = Number(mongoUri.port || "27017");
  if (!Number.isInteger(mongoPort) || mongoPort < 1 || mongoPort > 65_535) {
    throw new Error("OPENCODE_ARENA_MONGODB_URI has an invalid port");
  }
  if (!env.OPENCODE_ARENA_MONGODB_DATABASE?.trim()) {
    throw new Error("OPENCODE_ARENA_MONGODB_DATABASE is missing");
  }

  validateLocalControlPlaneUrl(env.PASEO_CONTROL_PLANE_URL);
  return { mongoPort };
}

function validateLocalControlPlaneUrl(value) {
  let controlPlaneUrl;
  try {
    controlPlaneUrl = new URL(value?.trim());
  } catch {
    throw new Error("PASEO_CONTROL_PLANE_URL is missing or invalid");
  }
  if (controlPlaneUrl.protocol !== "http:" || !LOCAL_MONGO_HOSTS.has(controlPlaneUrl.hostname)) {
    throw new Error("Desktop development requires a local control-plane URL");
  }
}

/**
 * An external control plane signs sessions with its own key, so the daemon needs that key's public
 * half from the environment or from the arena-backend/.env it reads, with the environment winning.
 */
export function validateExternalControlPlane(env, fileEnv = {}) {
  validateLocalControlPlaneUrl(env.PASEO_CONTROL_PLANE_URL);
  if (!{ ...fileEnv, ...env }.PASEO_SESSION_PUBLIC_KEY?.trim()) {
    throw new Error(
      "An external control plane needs PASEO_SESSION_PUBLIC_KEY set to its public key",
    );
  }
}

export function selectMongoContainer({ explicitName, publishedNames, port }) {
  if (explicitName?.trim()) return explicitName.trim();
  const existing = publishedNames.find((name) => name.toLowerCase().includes("mongo"));
  if (existing) return existing;
  return port === 27017 ? "agent-arena-mongodb" : `agent-arena-mongodb-${port}`;
}

function primaryCheckout(root) {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const first = output.match(/^worktree (.+)$/m)?.[1];
  return first ? path.resolve(first) : root;
}

function ensureArenaEnv(root) {
  const target = path.join(root, "arena-backend", ".env");
  if (existsSync(target)) return target;

  const source = path.join(primaryCheckout(root), "arena-backend", ".env");
  if (!existsSync(source) || source === target) {
    throw new Error(`Missing ${target}; create it from arena-backend/.env.example`);
  }
  symlinkSync(source, target);
  console.log(
    `[desktop-preflight] linked arena-backend/.env from ${path.dirname(path.dirname(source))}`,
  );
  return target;
}

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: options.stdio ?? "pipe" }).trim();
}

function ensureMongo(containerName, port) {
  let exists = true;
  try {
    docker(["inspect", containerName]);
  } catch {
    exists = false;
  }

  if (!exists) {
    docker(["run", "-d", "--name", containerName, "-p", `127.0.0.1:${port}:27017`, "mongo:8.0"], {
      stdio: "inherit",
    });
  } else if (docker(["inspect", "-f", "{{.State.Running}}", containerName]) !== "true") {
    docker(["start", containerName], { stdio: "inherit" });
  }

  const publishedPort = docker(["port", containerName, "27017/tcp"]);
  if (!publishedPort.split(/\r?\n/).some((entry) => entry.endsWith(`:${port}`))) {
    throw new Error(
      `MongoDB container ${containerName} does not publish its database on configured port ${port}`,
    );
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (
        docker([
          "exec",
          containerName,
          "mongosh",
          "--quiet",
          "--eval",
          "db.adminCommand({ping:1}).ok",
        ]) === "1"
      ) {
        return;
      }
    } catch {
      // MongoDB is still starting.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`MongoDB container ${containerName} did not become ready within 60 seconds`);
}

export function runDesktopPreflight({ root = process.cwd(), env = process.env } = {}) {
  const envFile = ensureArenaEnv(root);
  const fileEnv = parse(readFileSync(envFile));
  const mergedEnv = { ...fileEnv, ...env };
  const { mongoPort } = validateArenaEnvironment(mergedEnv);
  const publishedNames = docker([
    "ps",
    "-a",
    "--filter",
    `publish=${mongoPort}`,
    "--format",
    "{{.Names}}",
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  const containerName = selectMongoContainer({
    explicitName: env.PASEO_DEV_MONGO_CONTAINER,
    publishedNames,
    port: mongoPort,
  });
  ensureMongo(containerName, mongoPort);
  console.log(
    `[desktop-preflight] Arena configuration valid; MongoDB ${containerName} is healthy on port ${mongoPort}`,
  );
}

export function runExternalControlPlanePreflight({ root = process.cwd(), env = process.env } = {}) {
  const envFile = path.join(root, "arena-backend", ".env");
  validateExternalControlPlane(env, existsSync(envFile) ? parse(readFileSync(envFile)) : {});
  console.log(
    `[desktop-preflight] using the external control plane at ${env.PASEO_CONTROL_PLANE_URL}`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv[2] === "--database-name") {
      process.stdout.write(databaseNameForRoot(process.argv[3] ?? process.cwd()));
    } else if (process.argv[2] === "--external-control-plane") {
      runExternalControlPlanePreflight({
        root: process.argv[3] ? path.resolve(process.argv[3]) : process.cwd(),
      });
    } else {
      runDesktopPreflight({
        root: process.argv[2] ? path.resolve(process.argv[2]) : process.cwd(),
      });
    }
  } catch (error) {
    console.error(`[desktop-preflight] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
