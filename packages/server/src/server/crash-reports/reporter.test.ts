import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureCrashReporting, onCrashReported, reportCrash } from "./reporter.js";
import { pendingCrashReports, removeCrashReport } from "./store.js";

let home: string;

function startDaemon() {
  configureCrashReporting({ home, appVersion: "test", logPath: path.join(home, "daemon.log") });
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "crash-reporter-"));
  startDaemon();
});

afterEach(() => {
  vi.useRealTimers();
  onCrashReported(undefined);
  rmSync(home, { recursive: true, force: true });
});

const engineExit = {
  process: "engine",
  kind: "exit",
  message: "The battle engine exited before it was ready",
  exitCode: 1,
} as const;

function sendAll(): string[] {
  return pendingCrashReports(home).map((report) => {
    removeCrashReport(home, report.id);
    return report.crash.message;
  });
}

test("reports a crash that repeats once a day and counts the rest in the next report", () => {
  vi.useFakeTimers({ now: new Date("2026-11-17T18:51:00.000Z") });
  const recorded = vi.fn();
  onCrashReported(recorded);

  // An engine that cannot start, retried every 5 minutes for a day.
  for (let index = 0; index < 288; index += 1) {
    reportCrash(engineExit);
    vi.advanceTimersByTime(5 * 60_000);
  }

  expect(recorded).toHaveBeenCalledTimes(1);
  expect(sendAll()).toEqual(["The battle engine exited before it was ready"]);

  reportCrash(engineExit);
  expect(sendAll()).toEqual([
    "The battle engine exited before it was ready\nThe same crash happened 287 more times after the previous report at 2026-11-17T18:51:00.000Z.",
  ]);
  expect(recorded).toHaveBeenCalledTimes(2);
});

test("a restarted daemon does not report a crash reported earlier that day again", () => {
  vi.useFakeTimers({ now: new Date("2026-11-17T18:51:00.000Z") });
  reportCrash(engineExit);
  expect(sendAll()).toHaveLength(1);

  vi.advanceTimersByTime(60 * 60_000);
  startDaemon();
  reportCrash(engineExit);
  expect(sendAll()).toEqual([]);

  vi.advanceTimersByTime(23 * 60 * 60_000);
  startDaemon();
  reportCrash(engineExit);
  expect(sendAll()).toEqual([
    "The battle engine exited before it was ready\nThe same crash happened 1 more time after the previous report at 2026-11-17T18:51:00.000Z.",
  ]);
});

test("reports different crashes separately", () => {
  reportCrash(engineExit);
  reportCrash({ ...engineExit, exitCode: 134 });
  reportCrash({ ...engineExit, message: "The battle engine exited unexpectedly" });
  reportCrash({ process: "daemon", kind: "exception", message: "boom" });

  expect(pendingCrashReports(home)).toHaveLength(4);
});
