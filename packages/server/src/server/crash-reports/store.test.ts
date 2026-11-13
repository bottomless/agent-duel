import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveCrashReports,
  claimRunningMarker,
  crashReportsAwaitingUser,
  crashReportsDirectory,
  describeUncleanShutdown,
  isReadyToSend,
  pendingCrashReports,
  readLogTail,
  recordCrashReport,
  recordMarkerExit,
  recordMarkerStopping,
  recordSessionEnding,
  releaseRunningMarker,
  releaseStoppedMarker,
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
      logPaths: [logPath],
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

  it("attaches the daemon's and the engine's log tails, each under its file name", () => {
    const daemonLog = path.join(home, "daemon.log");
    const engineLog = path.join(home, "engine.log");
    writeFileSync(
      daemonLog,
      Array.from({ length: 150 }, (_, index) => `daemon ${index}`).join("\n"),
    );
    writeFileSync(
      engineLog,
      Array.from({ length: 150 }, (_, index) => `engine ${index}`).join("\n"),
    );

    const report = recordCrashReport({
      home,
      crash: { process: "engine", kind: "exit", message: "The battle engine exited", exitCode: 1 },
      appVersion: "0.4.0-beta.16",
      logPaths: [daemonLog, engineLog],
    });

    const tail = report?.logTail ?? [];
    expect(tail).toHaveLength(200);
    expect(tail.slice(0, 2)).toEqual(["==> daemon.log <==", "daemon 51"]);
    expect(tail.slice(99, 102)).toEqual(["daemon 149", "==> engine.log <==", "engine 51"]);
    expect(tail.at(-1)).toBe("engine 149");
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

describe("external ends", () => {
  function record(crash: Parameters<typeof recordCrashReport>[0]["crash"]) {
    return recordCrashReport({ home, crash, appVersion: "0.4.0-beta.17" })!;
  }

  it("holds back what something outside the app ended and sends the app's own failures", () => {
    const unclean = record({ process: "app", kind: "unclean_shutdown", message: "Gone" });
    const killed = record({
      process: "daemon",
      kind: "exit",
      message: "Killed",
      signal: "SIGKILL",
    });
    const gpu = record({ process: "app", kind: "exit", message: "GPU killed", external: true });
    const segfault = record({
      process: "engine",
      kind: "exit",
      message: "Segv",
      signal: "SIGSEGV",
    });
    const exitCode = record({ process: "engine", kind: "exit", message: "Exited", exitCode: 1 });
    const exception = record({ process: "daemon", kind: "exception", message: "TypeError" });

    expect([unclean, killed, gpu].map((report) => isReadyToSend(report))).toEqual([
      false,
      false,
      false,
    ]);
    expect([segfault, exitCode, exception].map((report) => isReadyToSend(report))).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      crashReportsAwaitingUser(home)
        .map((report) => report.id)
        .sort(),
    ).toEqual([unclean.id, killed.id, gpu.id].sort());
  });

  it("sends an external end once the user approves it, with their message", () => {
    const first = record({ process: "app", kind: "unclean_shutdown", message: "Gone" });
    const second = record({ process: "daemon", kind: "unclean_shutdown", message: "Gone" });

    approveCrashReports(home, [first.id], "My Mac froze and I held the power button");

    const approved = pendingCrashReports(home).find((report) => report.id === first.id);
    expect(approved?.sendApproved).toEqual({
      message: "My Mac froze and I held the power button",
    });
    expect(isReadyToSend(approved!)).toBe(true);
    expect(crashReportsAwaitingUser(home).map((report) => report.id)).toEqual([second.id]);
  });

  it("reads reports written before external ends were held back as ready to send", () => {
    const report = record({ process: "app", kind: "unclean_shutdown", message: "Gone" });
    const file = path.join(crashReportsDirectory(home), `${report.id}.json`);
    const { external: _external, ...older } = report;
    writeFileSync(file, JSON.stringify(older));

    expect(pendingCrashReports(home).map((pending) => isReadyToSend(pending))).toEqual([true]);
  });
});

describe("running marker", () => {
  it("treats a run killed after it began a requested shutdown as a normal exit", () => {
    claimRunningMarker({ home, name: "daemon", version: "1" });
    recordMarkerStopping(home, "daemon");
    const marker = JSON.parse(
      readFileSync(path.join(crashReportsDirectory(home), "daemon.running"), "utf8"),
    );
    expect(marker.stoppingAt).toEqual(expect.any(String));
    // The next run sees the same marker under another process id, with the old process gone.
    writeFileSync(
      path.join(crashReportsDirectory(home), "daemon.running"),
      JSON.stringify({ ...marker, pid: 999_999 }),
    );
    recordMarkerExit({
      home,
      name: "daemon",
      pid: 999_999,
      exit: { code: null, signal: "SIGKILL" },
    });

    expect(
      claimRunningMarker({ home, name: "daemon", version: "1", isAlive: () => false }),
    ).toBeNull();
  });

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
      bootedAt: 0,
    });

    expect(previous).toEqual({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" });
  });

  it("carries the signal its supervisor saw into the next run's report", () => {
    const marker = { pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" };
    claimRunningMarker({ home, name: "daemon", version: "1" });
    writeFileSync(path.join(crashReportsDirectory(home), "daemon.running"), JSON.stringify(marker));

    // Another process's marker is left as it is.
    recordMarkerExit({ home, name: "daemon", pid: 123, exit: { code: 1, signal: null } });
    recordMarkerExit({
      home,
      name: "daemon",
      pid: 999_999,
      exit: { code: null, signal: "SIGKILL" },
    });
    const previous = claimRunningMarker({
      home,
      name: "daemon",
      version: "2",
      isAlive: () => false,
      bootedAt: 0,
    });

    expect(previous?.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(describeUncleanShutdown("The daemon", previous!)).toBe(
      "The daemon (version 1, process 999999, started 2026-10-25T01:00:00.000Z) was killed by SIGKILL",
    );
  });

  it("does not report a run that started before the machine booted", () => {
    claimRunningMarker({ home, name: "daemon", version: "1" });
    writeFileSync(
      path.join(crashReportsDirectory(home), "daemon.running"),
      JSON.stringify({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
    );

    expect(
      claimRunningMarker({
        home,
        name: "daemon",
        version: "2",
        isAlive: () => false,
        bootedAt: Date.parse("2026-10-25T08:00:00.000Z"),
      }),
    ).toBeNull();
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

  it("does not report a run that was stopped on purpose", () => {
    const file = path.join(crashReportsDirectory(home), "daemon.running");
    claimRunningMarker({ home, name: "daemon", version: "1" });
    writeFileSync(
      file,
      JSON.stringify({ pid: 999_999, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
    );

    // Still running: the stop has not landed yet.
    releaseStoppedMarker({ home, name: "daemon", isAlive: () => true });
    expect(readdirSync(crashReportsDirectory(home))).toContain("daemon.running");

    releaseStoppedMarker({ home, name: "daemon", isAlive: () => false });
    expect(
      claimRunningMarker({ home, name: "daemon", version: "2", isAlive: () => false }),
    ).toBeNull();
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

  it("does not report the runs a session end took down, the app's and the daemon's", () => {
    const directory = crashReportsDirectory(home);
    claimRunningMarker({ home, name: "app", version: "1" });
    // Both runs the system is about to end; the app hears of it, the daemon does not.
    for (const [name, pid] of [
      ["app", 999_998],
      ["daemon", 999_999],
    ] as const) {
      writeFileSync(
        path.join(directory, `${name}.running`),
        JSON.stringify({ pid, version: "1", startedAt: "2026-10-25T01:00:00.000Z" }),
      );
    }

    recordSessionEnding(home);

    // The machine kept its uptime (a Windows shut down with Fast Startup), so the boot time does
    // not explain either marker.
    for (const name of ["app", "daemon"]) {
      expect(
        claimRunningMarker({ home, name, version: "2", isAlive: () => false, bootedAt: 0 }),
      ).toBeNull();
    }
  });

  it("keeps a stop already under way as it was when the session ends", () => {
    const file = path.join(crashReportsDirectory(home), "daemon.running");
    claimRunningMarker({ home, name: "daemon", version: "1" });
    recordMarkerStopping(home, "daemon");
    const before = readFileSync(file, "utf8");

    recordSessionEnding(home);

    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does nothing when no run left a marker", () => {
    expect(() => recordSessionEnding(home)).not.toThrow();
    expect(readdirSync(home)).toEqual([]);
  });
});
