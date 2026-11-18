import { createHash } from "node:crypto";
import {
  countRepeatedCrash,
  previousCrashReport,
  recordCrashReport,
  recordCrashReported,
  type CrashInput,
  type CrashRepeat,
} from "./store.js";

// A crash that repeats, such as an engine that cannot start, is reported once a day: the first
// report says what broke, and each later one that it still does and how often. The last report's
// time is kept on disk, so restarting the app does not report it again.
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CrashReporting {
  readonly home: string;
  readonly appVersion: string | null;
  readonly logPath: string;
  onRecorded?: () => void;
}

// The daemon worker configures this once at start, before anything can crash, so code deep in
// the daemon (the engine's exit handler) reports without being handed the daemon's home.
let reporting: CrashReporting | null = null;

export function configureCrashReporting(config: Omit<CrashReporting, "onRecorded">): void {
  reporting = { ...config, onRecorded: reporting?.onRecorded };
}

/** Runs after each recorded crash; the sender uses it to send while the daemon is still up. */
export function onCrashReported(listener: (() => void) | undefined): void {
  if (reporting) reporting.onRecorded = listener;
}

function crashKey(crash: CrashInput): string {
  const identity = [
    crash.process,
    crash.kind,
    crash.message,
    crash.exitCode ?? null,
    crash.signal ?? null,
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

function withRepeats(message: string, previous: CrashRepeat): string {
  const times = previous.repeats === 1 ? "time" : "times";
  const since = new Date(previous.reportedAt).toISOString();
  return `${message}\nThe same crash happened ${previous.repeats} more ${times} after the previous report at ${since}.`;
}

/**
 * Writes a crash report synchronously, with the daemon log's tail followed by each of `logPaths`.
 * The same crash again within a day of its report is only counted. Does nothing until crash
 * reporting is configured.
 */
export function reportCrash(crash: CrashInput, logPaths: readonly string[] = []): void {
  if (!reporting) return;
  const { home } = reporting;
  const key = crashKey(crash);
  const now = Date.now();
  const previous = previousCrashReport(home, key);
  if (previous && now - previous.reportedAt < REPEAT_WINDOW_MS) {
    countRepeatedCrash(home, key);
    return;
  }
  const report = recordCrashReport({
    home,
    crash: previous?.repeats ? { ...crash, message: withRepeats(crash.message, previous) } : crash,
    appVersion: reporting.appVersion,
    logPaths: [reporting.logPath, ...logPaths],
  });
  if (!report) return;
  recordCrashReported(home, key, now);
  reporting.onRecorded?.();
}
