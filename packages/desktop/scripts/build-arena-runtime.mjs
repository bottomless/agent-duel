#!/usr/bin/env node
import { mkdirSync } from "node:fs";
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

mkdirSync(outputDir, { recursive: true });
const result = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--conditions=browser",
    // A long-lived engine otherwise keeps its peak heap: collect more often and keep it smaller.
    "--compile-exec-argv=--smol",
    "packages/opencode/src/index.ts",
    "--outfile",
    output,
  ],
  { cwd: arenaDir, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
