import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRulesync } from "./rulesync.js";

// The packaged daemon runs rulesync with the Electron binary in Node mode. This preload gives a plain
// Node child the one thing commander reads to tell the two apart.
const FAKE_ELECTRON = 'Object.defineProperty(process.versions, "electron", { value: "44.0.0" });\n';

describe("runRulesync", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rulesync-run-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  // `import` with nothing to import exits 0; a misread argv fails with "unknown command".
  const args = ["import", "--targets", "claudecode", "--features", "commands"];

  it("runs a command under Node", async () => {
    await expect(runRulesync(args, root)).resolves.toBeUndefined();
  });

  it("runs a command when the daemon is Electron", async () => {
    const preload = path.join(root, "fake-electron.cjs");
    await fs.writeFile(preload, FAKE_ELECTRON);
    vi.stubEnv("NODE_OPTIONS", `--require ${JSON.stringify(preload)}`);

    await expect(runRulesync(args, root)).resolves.toBeUndefined();
  });

  it("runs a command when the inherited NODE_OPTIONS makes eval code ESM", async () => {
    vi.stubEnv("NODE_OPTIONS", "--input-type=module");

    await expect(runRulesync(args, root)).resolves.toBeUndefined();
  });

  it("reports rulesync's own refusal, naming the command it was given", async () => {
    await expect(runRulesync(["no-such-command"], root)).rejects.toThrow(
      "rulesync no-such-command failed: error: unknown command 'no-such-command'",
    );
  });
});
