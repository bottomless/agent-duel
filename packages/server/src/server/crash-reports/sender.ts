import type { Logger } from "pino";
import type { FeedbackContext, FeedbackSubmission } from "@getpaseo/protocol/feedback/schemas";
import type { FeedbackRemote } from "../feedback/backend.js";
import { pendingCrashReports, removeCrashReport, type StoredCrashReport } from "./store.js";

const SEND_INTERVAL_MS = 60_000;

export interface CrashReportSenderDependencies {
  readonly home: string;
  readonly backend: FeedbackRemote;
  /** The signed-in account's session, or null while nobody is signed in. */
  readonly token: () => string | null;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

function locale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function submission(report: StoredCrashReport): FeedbackSubmission {
  return {
    id: report.id,
    source: "crash",
    details: {
      appVersion: report.appVersion,
      platform: "desktop",
      operatingSystem: report.operatingSystem,
      locale: locale(),
    },
    crash: report.crash,
  };
}

function context(report: StoredCrashReport): FeedbackContext {
  return {
    version: 1,
    capturedAt: report.crash.occurredAt,
    agent: null,
    git: null,
    log: report.logTail,
    timeline: [],
  };
}

/**
 * Sends the crash reports on disk as feedback, with the log tail as its context. It sends on
 * start, after every crash the daemon records, and on an interval, which picks up reports the
 * desktop app wrote and reports that waited for a signed-in session. A report is deleted once the
 * control plane has it; the report id is the feedback id, so sending one again is harmless.
 */
export class CrashReportSender {
  private readonly dependencies: CrashReportSenderDependencies;
  private running: Promise<void> | null = null;
  private requested = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: CrashReportSenderDependencies) {
    this.dependencies = dependencies;
  }

  start(): void {
    void this.flush();
    this.timer = setInterval(
      () => void this.flush(),
      this.dependencies.intervalMs ?? SEND_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sends every pending report. A call during a send runs once more after it. */
  flush(): Promise<void> {
    if (this.running) {
      this.requested = true;
      return this.running;
    }
    this.running = this.send().finally(() => {
      this.running = null;
      if (!this.requested) return;
      this.requested = false;
      void this.flush();
    });
    return this.running;
  }

  private async send(): Promise<void> {
    const { home, backend, logger } = this.dependencies;
    const reports = pendingCrashReports(home);
    if (reports.length === 0) return;
    const token = this.dependencies.token();
    if (!token) return;
    for (const report of reports) {
      try {
        await backend.submit(token, submission(report));
      } catch (error) {
        // The next interval tries again; the reports stay on disk until then.
        logger.warn({ err: error, crashReportId: report.id }, "Crash report could not be sent");
        return;
      }
      // The control plane waits for a crash report's context, so it goes even with no log lines.
      // `uploadContext` reports its own failure to the control plane and never throws.
      await backend.uploadContext(token, report.id, context(report));
      removeCrashReport(home, report.id);
    }
  }
}
