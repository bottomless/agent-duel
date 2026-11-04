import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resolveEngineLogPath } from "../agent/providers/opencode/paths.js";
import { configureCrashReporting, onCrashReported, reportCrash } from "./reporter.js";
import { pendingCrashReports } from "./store.js";

test("an engine crash reads the same file the 2.0 log hook writes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arena-engine-report-"));
  const util = fileURLToPath(
    new URL("../../../../../arena-backend/packages/util/", import.meta.url),
  );
  const engineLog = resolveEngineLogPath({ PASEO_HOME: home });
  const daemonLog = path.join(home, "daemon.log");
  try {
    await writeFile(daemonLog, "daemon merge regression\n");
    const writer = spawnSync(
      "bun",
      [
        "--no-env-file",
        "-e",
        `
      import { Effect, Logger } from "effect";
      import { LayerNode } from "./src/effect/layer-node.ts";
      import { filesystem } from "./src/effect/app-node-platform.ts";
      import { Logging } from "./src/observability/logging.ts";
      await Effect.gen(function* () {
        const logger = yield* Logging.fileLogger();
        yield* Effect.logInfo("engine report regression").pipe(Effect.provide(Logger.layer([logger])));
      }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(filesystem)), Effect.runPromise);
    `,
      ],
      {
        cwd: util,
        env: { ...process.env, OPENCODE_LOG_FILE: engineLog },
        encoding: "utf8",
      },
    );
    expect(writer.status, writer.stderr).toBe(0);
    expect(await readFile(engineLog, "utf8")).toContain("engine report regression");
    configureCrashReporting({ home, appVersion: "merge-test", logPath: daemonLog });
    reportCrash({ process: "engine", kind: "exit", message: "unexpected exit", exitCode: 1 }, [
      engineLog,
    ]);
    const reports = pendingCrashReports(home);
    expect(reports).toHaveLength(1);
    expect(reports[0].logTail.join("\n")).toContain("daemon merge regression");
    expect(reports[0].logTail.join("\n")).toContain("==> engine.log <==");
    expect(reports[0].logTail.join("\n")).toContain("engine report regression");
  } finally {
    onCrashReported(undefined);
    await rm(home, { recursive: true, force: true });
  }
});
