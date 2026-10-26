import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveArenaBuildDefines } from "./build-arena-runtime.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const opencode = JSON.parse(
  readFileSync(path.join(root, "arena-backend/packages/opencode/package.json"), "utf8"),
);
const agentDuel = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

describe("packaged Arena build metadata", () => {
  test("reserves build zero for local builds and rejects malformed release build numbers", () => {
    expect(resolveArenaBuildDefines({})).toEqual({
      OPENCODE_VERSION: JSON.stringify(opencode.version),
      AGENT_DUEL_BUILD_NUMBER: "0",
    });
    for (const build of ["-1", "1.5", "NaN", "1e3", "9007199254740992"]) {
      expect(() => resolveArenaBuildDefines({ AGENT_DUEL_BUILD_NUMBER: build })).toThrow(
        "AGENT_DUEL_BUILD_NUMBER must be a non-negative safe integer",
      );
    }
  });

  test("a compiled runtime keeps both versions and its build number outside the source checkout", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agent-duel-build-metadata-"));
    try {
      const entry = path.join(directory, "metadata.ts");
      const executable = path.join(
        directory,
        process.platform === "win32" ? "metadata.exe" : "metadata",
      );
      const provenance = path.join(root, "arena-backend/packages/opencode/src/arena/provenance.ts");
      writeFileSync(
        entry,
        `import { resolveBuildMetadata } from ${JSON.stringify(provenance)};
console.log(JSON.stringify(await resolveBuildMetadata()));
`,
      );
      const defines = resolveArenaBuildDefines({ AGENT_DUEL_BUILD_NUMBER: "42" });
      execFileSync(
        "bun",
        [
          "build",
          "--compile",
          entry,
          "--outfile",
          executable,
          ...Object.entries(defines).flatMap(([key, value]) => ["--define", `${key}=${value}`]),
        ],
        { cwd: directory, stdio: "pipe" },
      );
      rmSync(entry);
      const stdout = execFileSync(executable, [], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCODE_ARENA_BUILD_SHA: "abcdef1234567",
          AGENT_DUEL_BUILD_NUMBER: "999",
        },
      });
      expect(JSON.parse(stdout)).toEqual({
        opencodeVersion: opencode.version,
        agentDuelVersion: agentDuel.version,
        agentDuelBuildNumber: 42,
        agentDuelCommit: "abcdef1234567",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("the compiled engine starts with its native assets outside the checkout", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-duel-engine-package-"));
  const executableName = process.platform === "win32" ? "agent-duel-arena.exe" : "agent-duel-arena";
  const executable = path.join(directory, executableName);
  let child;
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "packages/desktop/scripts/build-arena-runtime.mjs")],
      { cwd: root, stdio: "pipe" },
    );
    const assets = [
      executableName,
      "watcher.node",
      ...(process.platform === "win32" ? [] : ["opencode-pty"]),
    ];
    for (const asset of assets)
      copyFileSync(
        path.join(root, "packages/desktop/dist/arena", asset),
        path.join(directory, asset),
      );
    const token = "packaged-engine-test";
    child = spawn(
      executable,
      ["--arena-credentials-stdin", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PASEO_HOME: path.join(directory, "paseo"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
          OPENCODE_TEST_HOME: path.join(directory, "home"),
          OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
        },
      },
    );
    child.stdin.end(
      JSON.stringify({
        mode: "byok",
        openRouterApiKey: "test-key",
        controlTokenHash: createHash("sha256").update(token).digest("hex"),
      }),
    );
    const url = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Engine startup timed out: ${output}`)),
        20_000,
      );
      const capture = (chunk) => {
        output += chunk.toString();
        const match = /Agent Arena backend listening on (http:\/\/[^\s]+)/.exec(output);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Engine exited (${code}): ${output}`));
      });
    });
    const health = await fetch(new URL("/global/health", url));
    expect(await health.json()).toEqual({ healthy: true, version: opencode.version });
    expect((await fetch(new URL("/api/info", url))).status).toBe(404);
    const info = await fetch(new URL("/api/info", url), {
      headers: { "x-paseo-control-token": token },
    });
    expect(info.status).toBe(200);
    const session = await fetch(new URL("/api/session", url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-paseo-control-token": token },
      body: JSON.stringify({
        location: { directory },
        model: { id: "medium", providerID: "arena" },
      }),
    });
    expect(session.status).toBe(200);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
