import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { buildSelfNodeCommand } from "../../paseo-env.js";

const TIMEOUT_MS = 120_000;

/** rulesync exited non-zero. `reason` is its first output line, which names what it refused. */
export class RulesyncError extends Error {
  readonly args: readonly string[];
  readonly reason: string;
  readonly exitCode: number | null;

  constructor(input: { args: readonly string[]; output: string; exitCode: number | null }) {
    const reason =
      input.output
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? `rulesync exited with code ${input.exitCode}`;
    super(`rulesync ${input.args[0]} failed: ${reason}`);
    this.name = "RulesyncError";
    this.args = input.args;
    this.reason = reason;
    this.exitCode = input.exitCode;
  }
}

function resolveRulesyncCli(): string {
  // The package exports only its library entry; its CLI sits beside it in `dist/cli`.
  const library = createRequire(import.meta.url).resolve("rulesync");
  return path.join(path.dirname(library), "cli", "index.js");
}

/**
 * Runs the rulesync CLI in a child process. Its library API reads `process.cwd()`, which a daemon
 * serving many projects cannot change.
 */
export function runRulesync(args: readonly string[], cwd: string): Promise<void> {
  // rulesync goes silent under `NODE_ENV=test`, and its output is the reason a plugin failed.
  const launch = buildSelfNodeCommand([resolveRulesyncCli(), ...args], {
    NO_COLOR: "1",
    NODE_ENV: undefined,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new RulesyncError({ args, output, exitCode }));
    });
  });
}
