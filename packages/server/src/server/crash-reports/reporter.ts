import { recordCrashReport, type CrashInput } from "./store.js";

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

/** Writes a crash report synchronously. Does nothing until crash reporting is configured. */
export function reportCrash(crash: CrashInput): void {
  if (!reporting) return;
  const report = recordCrashReport({
    home: reporting.home,
    crash,
    appVersion: reporting.appVersion,
    logPath: reporting.logPath,
  });
  if (report) reporting.onRecorded?.();
}
