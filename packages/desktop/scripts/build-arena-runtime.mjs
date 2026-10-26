#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const arenaDir = path.resolve(rootDir, "arena-backend");
const outputDir = path.resolve(desktopDir, "dist/arena");
const executable = process.platform === "win32" ? "agent-duel-arena.exe" : "agent-duel-arena";
const output = path.join(outputDir, executable);

export function resolveArenaBuildDefines(env) {
  const rawBuildNumber = env.AGENT_DUEL_BUILD_NUMBER?.trim() || "0";
  const buildNumber = Number(rawBuildNumber);
  if (!/^\d+$/.test(rawBuildNumber) || !Number.isSafeInteger(buildNumber)) {
    throw new Error("AGENT_DUEL_BUILD_NUMBER must be a non-negative safe integer");
  }
  const opencode = JSON.parse(
    readFileSync(path.join(arenaDir, "packages/opencode/package.json"), "utf8"),
  );
  return {
    OPENCODE_VERSION: JSON.stringify(opencode.version),
    AGENT_DUEL_BUILD_NUMBER: String(buildNumber),
  };
}

function buildArenaRuntime() {
  const defines = resolveArenaBuildDefines(process.env);
  mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(
    "bun",
    ["run", "packages/opencode/script/build-desktop.ts", output, JSON.stringify(defines)],
    { cwd: arenaDir, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  // Without the watcher binding the engine cannot trust a warm pair and re-syncs both sides at every
  // send. Bun compiles a require it cannot resolve into a throw instead of failing the build.
  const binding = `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`;
  if (readFileSync(output).includes(`Cannot require module "+"${binding}`)) {
    console.error(
      `${executable} was compiled without ${binding}; run bun install in arena-backend`,
    );
    process.exit(1);
  }
  // The compiled copy is extracted to an unsigned temp file at run time, which the hardened runtime
  // refuses to load. Ship the binding beside the executable, where the app's signature covers it.
  const engineRequire = createRequire(path.join(arenaDir, "packages/opencode/package.json"));
  copyFileSync(
    engineRequire.resolve(`${binding}/watcher.node`),
    path.join(outputDir, "watcher.node"),
  );
  if (process.platform !== "win32") {
    const coreRequire = createRequire(path.join(arenaDir, "packages/core/package.json"));
    const ptyRequire = createRequire(coreRequire.resolve("@opencode-ai/pty/package.json"));
    const libc = process.platform === "linux" ? "-gnu" : "";
    const pty = `@opencode-ai/pty-${process.platform}-${process.arch}${libc}`;
    const destination = path.join(outputDir, "opencode-pty");
    copyFileSync(ptyRequire.resolve(`${pty}/bin/opencode-pty`), destination);
    chmodSync(destination, 0o755);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) buildArenaRuntime();
