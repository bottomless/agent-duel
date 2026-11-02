#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
  // build-desktop.ts writes the executable and every native file it loads; drop files an older build left.
  rmSync(outputDir, { recursive: true, force: true });
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
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) buildArenaRuntime();
