import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimRunningMarker,
  crashReportsDirectory,
  pendingCrashReports,
  readLogTail,
  recordCrashReport,
  releaseRunningMarker,
  removeCrashReport,
} from "./store.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "crash-reports-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("crash report store", () => {
  it("records a crash with the end of the log and keeps it until it is removed", () => {
    const logPath = path.join(home, "daemon.log");
    writeFileSync(logPath, Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n"));

    const report = recordCrashReport({
      home,
      crash: { process: "engine", kind: "exit", message: "The battle engine exited", exitCode: 1 },
      appVersion: "0.4.0-beta.15",
      logPath,
    });

    expect(report?.crash).toMatchObject({
      process: "engine",
      kind: "exit",
      exitCode: 1,
      signal: null,
    });
    expect(report?.logTail).toHaveLength(200);
    expect(report?.logTail.at(0)).toBe("line 50");
    expect(report?.logTail.at(-1)).toBe("line 249");
    expect(pendingCrashReports(home).map((pending) => pending.id)).toEqual([report?.id]);

    removeCrashReport(home, report!.id);
    expect(pendingCrashReports(home)).toEqual([]);
  });

  it("drops the partial first line of a log it reads from the middle", () => {
    const logPath = path.join(home, "daemon.log");
    writeFileSync(logPath, `${"x".repeat(300 * 1024)}\nwhole line\n`);

    expect(readLogTail(logPath)).toEqual(["whole line"]);
  });

  it("keeps only the newest twenty reports", () => {
    for (let index = 0; index < 25; index += 1) {
      recordCrashReport({
        home,
        crash: { process: "daemon", kind: "exception", message: `crash ${index}` },
        appVersion: null,
      });
    }

    expect(pendingCrashReports(home)).toHaveLength(20);
  });

  it("deletes a report it cannot read", () => {
    const directory = crashReportsDirectory(home);
    recordCrashReport({
      home,
      crash: { process: "app", kind: "exception", message: "boom" },
      appVersion: null,
    });
    writeFileSync(path.join(directory, "broken.json"), "{");

    expect(pendingCrashReports(home)).toHaveLength(1);
    expect(readdirSync(directory)).not.toContain("broken.json");
  });
});

describe("running marker", () => {
  it("returns the previous run when it ended without exiting", () => {
    const directory = crashReportsDirectory(home);
    claimRunningMarker({ home, name: "daemon", version: "1" });
    // A marker another process left behind.
    writeFileSync(
      path.join(directory, "daemon.running"),
      JSON.stringify({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
    );

    const previous = claimRunningMarker({
      home,
      name: "daemon",
      version: "2",
      isAlive: () => false,
    });

    expect(previous).toEqual({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" });
  });

  it("returns nothing when the previous run exited or is still running", () => {
    expect(claimRunningMarker({ home, name: "daemon", version: "1" })).toBeNull();
    releaseRunningMarker(home, "daemon");
    expect(claimRunningMarker({ home, name: "daemon", version: "1" })).toBeNull();

    writeFileSync(
      path.join(crashReportsDirectory(home), "app.running"),
      JSON.stringify({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
    );
    expect(claimRunningMarker({ home, name: "app", version: "1", isAlive: () => true })).toBeNull();
  });

  it("leaves another process's marker in place", () => {
    const file = path.join(crashReportsDirectory(home), "app.running");
    claimRunningMarker({ home, name: "app", version: "1" });
    writeFileSync(
      file,
      JSON.stringify({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
    );

    releaseRunningMarker(home, "app");

    expect(readdirSync(crashReportsDirectory(home))).toContain("app.running");
  });
});
