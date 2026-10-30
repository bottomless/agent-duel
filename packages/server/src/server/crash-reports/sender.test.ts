import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedbackContext, FeedbackSubmission } from "@getpaseo/protocol/feedback/schemas";
import { FeedbackBackendError, type FeedbackRemote } from "../feedback/backend.js";
import { CrashReportSender } from "./sender.js";
import { pendingCrashReports, recordCrashReport } from "./store.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "crash-sender-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function remote(options?: { failSubmit?: boolean }) {
  const submitted: Array<{ token: string; feedback: FeedbackSubmission }> = [];
  const contexts: Array<{ feedbackId: string; context: FeedbackContext }> = [];
  const backend: FeedbackRemote = {
    async submit(token, feedback) {
      if (options?.failSubmit)
        throw new FeedbackBackendError(503, "Feedback could not be delivered");
      submitted.push({ token, feedback });
      return { id: feedback.id, emailed: true };
    },
    async uploadContext(_token, feedbackId, context) {
      contexts.push({ feedbackId, context });
    },
    async reportContextFailure() {},
  };
  return { backend, submitted, contexts };
}

function engineCrash() {
  const logPath = path.join(home, "daemon.log");
  writeFileSync(logPath, "engine started\nengine failed\n");
  return recordCrashReport({
    home,
    crash: { process: "engine", kind: "exit", message: "The battle engine exited", exitCode: 1 },
    appVersion: "0.4.0-beta.15",
    logPath,
  })!;
}

describe("crash report sender", () => {
  it("sends a crash as feedback with the log tail as its context, then deletes it", async () => {
    const report = engineCrash();
    const control = remote();
    const sender = new CrashReportSender({
      home,
      backend: control.backend,
      token: () => "session-token",
      logger: pino({ level: "silent" }),
    });

    await sender.flush();

    expect(control.submitted).toEqual([
      {
        token: "session-token",
        feedback: expect.objectContaining({
          id: report.id,
          source: "crash",
          crash: report.crash,
          details: expect.objectContaining({ appVersion: "0.4.0-beta.15", platform: "desktop" }),
        }),
      },
    ]);
    expect(control.contexts).toEqual([
      {
        feedbackId: report.id,
        context: expect.objectContaining({
          agent: null,
          git: null,
          timeline: [],
          log: ["engine started", "engine failed"],
        }),
      },
    ]);
    expect(pendingCrashReports(home)).toEqual([]);
  });

  it("keeps reports while nobody is signed in or the control plane cannot be reached", async () => {
    engineCrash();
    const signedOut = remote();
    await new CrashReportSender({
      home,
      backend: signedOut.backend,
      token: () => null,
      logger: pino({ level: "silent" }),
    }).flush();
    const unreachable = remote({ failSubmit: true });
    await new CrashReportSender({
      home,
      backend: unreachable.backend,
      token: () => "session-token",
      logger: pino({ level: "silent" }),
    }).flush();

    expect(signedOut.submitted).toEqual([]);
    expect(pendingCrashReports(home)).toHaveLength(1);
  });
});
