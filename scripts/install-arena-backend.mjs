#!/usr/bin/env node
// Installs arena-backend from its lockfile. A daemon built from this checkout runs the engine from
// arena-backend's sources, and a pull can change that lockfile. Without a fresh install the engine
// exits at startup on a missing module and the daemon respawns it.
//
// Builds that never run the engine from this checkout, such as the offline Nix packages, set
// AGENT_DUEL_SKIP_ARENA_INSTALL=1.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arenaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../arena-backend");
const manifest = path.join(arenaDir, "package.json");

if (process.env.AGENT_DUEL_SKIP_ARENA_INSTALL === "1") {
  console.log("Skipping the arena-backend install (AGENT_DUEL_SKIP_ARENA_INSTALL=1)");
} else if (existsSync(manifest)) {
  const bun =
    JSON.parse(readFileSync(manifest, "utf8")).packageManager ?? "the Bun in packageManager";
  const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: arenaDir,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : `exit ${result.status ?? result.signal}`;
    console.error(`bun install failed in ${arenaDir} (${reason}); install ${bun} and build again`);
    process.exit(1);
  }
}
