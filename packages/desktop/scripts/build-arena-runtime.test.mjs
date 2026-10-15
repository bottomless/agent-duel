import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      const version = path.join(root, "arena-backend/packages/core/src/installation/version.ts");
      writeFileSync(
        entry,
        `import { resolveBuildMetadata } from ${JSON.stringify(provenance)};
import { InstallationVersion } from ${JSON.stringify(version)};
console.log(JSON.stringify({ version: InstallationVersion, metadata: await resolveBuildMetadata() }));
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
        version: opencode.version,
        metadata: {
          opencodeVersion: opencode.version,
          agentDuelVersion: agentDuel.version,
          agentDuelBuildNumber: 42,
          agentDuelCommit: "abcdef1234567",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
