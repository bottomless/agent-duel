import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  crashReportSchema,
  crashReportUserMessageSchema,
  feedbackLogLineMaximumLength,
  feedbackLogTailMaximumLines,
  type CrashReport,
} from "@getpaseo/protocol/feedback/schemas";

// Crash reports are written synchronously where the crash happens, often in a process about to
// exit, and the daemon sends them as feedback once it has a signed-in session. Every write and
// read here swallows its own failure: reporting a crash must never cause or hide one.
const DIRECTORY = "crash-reports";
const MAXIMUM_REPORTS = 20;
const MAXIMUM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LOG_TAIL_BYTES = 256 * 1024;

const storedCrashReportSchema = z
  .object({
    id: z.uuid(),
    crash: crashReportSchema,
    appVersion: z.string().trim().min(1).max(64).nullable(),
    operatingSystem: z.string().trim().min(1).max(128),
    logTail: z.array(z.string()),
    /**
     * Something outside the app ended the process: it was killed, force quit, or the computer
     * stopped. Nothing in the log explains it, so the report waits for the user to send it with
     * what they saw, or to discard it.
     */
    external: z.boolean().default(false),
    /** The user chose to send this report, with what they wrote about it. */
    sendApproved: z
      .object({ message: crashReportUserMessageSchema.nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type StoredCrashReport = z.infer<typeof storedCrashReportSchema>;

export interface CrashInput {
  readonly process: CrashReport["process"];
  readonly kind: CrashReport["kind"];
  readonly message: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** Set where only the caller can tell, such as Electron's `killed` reason; see `isExternalEnd`. */
  readonly external?: boolean;
}

// Signals a process receives from someone else. A crash in the process itself raises SIGSEGV,
// SIGABRT, SIGBUS and the like, which stay automatic reports.
const EXTERNAL_SIGNALS = new Set(["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]);

/**
 * A process found gone with no exit of its own, or killed by another process, ended for a reason
 * outside the app: a force quit, the system reclaiming memory, the computer restarting.
 */
export function isExternalEnd(crash: Pick<CrashInput, "kind" | "signal">): boolean {
  if (crash.kind === "unclean_shutdown") return true;
  return Boolean(crash.signal && EXTERNAL_SIGNALS.has(crash.signal));
}

export function crashReportsDirectory(home: string): string {
  return path.join(home, DIRECTORY);
}

export function operatingSystemName(): string {
  return `${os.type()} ${os.release()} ${os.arch()}`.slice(0, 128);
}

/** The last lines of a log, oldest first, read without loading the whole file. */
export function readLogTail(logPath: string, maximumLines = feedbackLogTailMaximumLines): string[] {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(logPath, "r");
    const size = fstatSync(descriptor).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line of a window that starts mid-file is a fragment.
    if (start > 0) lines.shift();
    return lines
      .filter((line) => line.trim().length > 0)
      .slice(-maximumLines)
      .map((line) => line.slice(0, feedbackLogLineMaximumLength));
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * The tails of the logs, in order. Several logs share the line budget, each under a header line
 * naming its file.
 */
export function readLogTails(logPaths: readonly string[]): string[] {
  if (logPaths.length <= 1) return logPaths[0] ? readLogTail(logPaths[0]) : [];
  const share = Math.floor(feedbackLogTailMaximumLines / logPaths.length) - 1;
  return logPaths.flatMap((logPath) => [
    `==> ${path.basename(logPath)} <==`,
    ...readLogTail(logPath, share),
  ]);
}

export function recordCrashReport(input: {
  readonly home: string;
  readonly crash: CrashInput;
  readonly appVersion: string | null;
  readonly logPaths?: readonly string[];
}): StoredCrashReport | null {
  try {
    const report = storedCrashReportSchema.parse({
      id: randomUUID(),
      crash: {
        process: input.crash.process,
        kind: input.crash.kind,
        occurredAt: new Date().toISOString(),
        message: input.crash.message.trim().slice(0, 5_000) || "No error message",
        exitCode: input.crash.exitCode ?? null,
        signal: input.crash.signal || null,
      },
      appVersion: input.appVersion?.trim().slice(0, 64) || null,
      operatingSystem: operatingSystemName(),
      logTail: readLogTails(input.logPaths ?? []),
      external: input.crash.external ?? isExternalEnd(input.crash),
    });
    writeCrashReport(input.home, report);
    pruneCrashReports(input.home);
    return report;
  } catch {
    return null;
  }
}

function writeCrashReport(home: string, report: StoredCrashReport) {
  const directory = crashReportsDirectory(home);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${report.id}.json`);
  // A report half written when the process died would be unreadable, so it appears whole.
  writeFileSync(`${target}.tmp`, JSON.stringify(report));
  renameSync(`${target}.tmp`, target);
}

function reportFiles(home: string) {
  const directory = crashReportsDirectory(home);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = path.join(directory, name);
        return { file, modified: statSync(file).mtimeMs };
      })
      .sort((left, right) => left.modified - right.modified);
  } catch {
    return [];
  }
}

/** Keeps the newest reports, so an app that crashes on every start cannot fill the disk. */
function pruneCrashReports(home: string) {
  const files = reportFiles(home);
  const now = Date.now();
  files.forEach((entry, index) => {
    const surplus = index < files.length - MAXIMUM_REPORTS;
    if (surplus || now - entry.modified > MAXIMUM_AGE_MS) rmSync(entry.file, { force: true });
  });
}

/** Reports waiting to be sent, oldest first. Unreadable ones are deleted. */
export function pendingCrashReports(home: string): StoredCrashReport[] {
  pruneCrashReports(home);
  return reportFiles(home).flatMap((entry) => {
    try {
      return [storedCrashReportSchema.parse(JSON.parse(readFileSync(entry.file, "utf8")))];
    } catch {
      rmSync(entry.file, { force: true });
      return [];
    }
  });
}

export function removeCrashReport(home: string, id: string): void {
  rmSync(path.join(crashReportsDirectory(home), `${id}.json`), { force: true });
}

/** Whether a report goes without asking: the app's own failures do, external ends wait. */
export function isReadyToSend(report: StoredCrashReport): boolean {
  return !report.external || report.sendApproved !== undefined;
}

/** External ends the user has not decided about yet, oldest first. */
export function crashReportsAwaitingUser(home: string): StoredCrashReport[] {
  return pendingCrashReports(home).filter((report) => !isReadyToSend(report));
}

/** Marks reports the user chose to send; the sender sends them with the user's message. */
export function approveCrashReports(
  home: string,
  ids: readonly string[],
  message: string | null,
): void {
  const wanted = new Set(ids);
  for (const report of pendingCrashReports(home)) {
    if (!wanted.has(report.id)) continue;
    try {
      writeCrashReport(home, { ...report, sendApproved: { message } });
    } catch {
      // Left waiting; the user is asked again on the next start.
    }
  }
}

const runningMarkerSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string().nullable(),
  startedAt: z.iso.datetime(),
  /**
   * When the run began a shutdown someone asked for (`recordMarkerStopping`). Being killed after
   * that, as the desktop app does to a daemon that takes too long to stop, is a normal exit.
   */
  stoppingAt: z.iso.datetime().optional(),
  /** How the process ended, when a supervisor saw it end (`recordMarkerExit`). */
  exit: z
    .object({ code: z.number().int().nullable(), signal: z.string().min(1).max(64).nullable() })
    .optional(),
});
export type RunningMarker = z.infer<typeof runningMarkerSchema>;

function markerPath(home: string, name: string) {
  return path.join(crashReportsDirectory(home), `${name}.running`);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

/**
 * Records that this process is running and returns the previous run's marker when that run never
 * removed it: it ended without exiting (a native crash, a force quit, a lost machine). Every exit,
 * a fatal one included, removes the marker (`releaseRunningMarker`), and a fatal one writes its
 * own report, so a marker left behind is the only trace of the rest.
 *
 * A run that started before this boot ended with the machine: Windows ends the daemon at shutdown
 * or restart without a signal it can handle, so that marker is not a crash. A Windows shut down
 * with Fast Startup keeps the uptime, so the app also marks every run at the session's end
 * (`recordSessionEnding`).
 */
export function claimRunningMarker(input: {
  readonly home: string;
  readonly name: string;
  readonly version: string | null;
  readonly isAlive?: (pid: number) => boolean;
  /** When the machine booted, in milliseconds since the epoch. */
  readonly bootedAt?: number;
}): RunningMarker | null {
  const file = markerPath(input.home, input.name);
  let previous: RunningMarker | null = null;
  try {
    previous = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    previous = null;
  }
  const isAlive = input.isAlive ?? isProcessAlive;
  const bootedAt = input.bootedAt ?? Date.now() - os.uptime() * 1000;
  const ended =
    previous !== null &&
    previous.pid !== process.pid &&
    previous.stoppingAt === undefined &&
    Date.parse(previous.startedAt) >= bootedAt &&
    !isAlive(previous.pid);
  try {
    mkdirSync(crashReportsDirectory(input.home), { recursive: true });
    const marker: RunningMarker = {
      pid: process.pid,
      version: input.version,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(marker));
  } catch {
    // Without a marker the next start cannot tell how this one ended; nothing else depends on it.
  }
  return ended ? previous : null;
}

/** Removes this process's marker. Synchronous, so it can run in an `exit` handler. */
export function releaseRunningMarker(home: string, name: string): void {
  const file = markerPath(home, name);
  try {
    const marker = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (marker.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // Missing or unreadable: nothing of this process's to remove.
  }
}

/**
 * Removes the marker of a process that was stopped on purpose and is gone, so its next run does not
 * report a crash. A stop by signal runs no exit handler on Windows: the signal is TerminateProcess.
 * A marker whose process is still alive is left alone.
 */
export function releaseStoppedMarker(input: {
  readonly home: string;
  readonly name: string;
  readonly isAlive?: (pid: number) => boolean;
}): void {
  const file = markerPath(input.home, input.name);
  try {
    const marker = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (!(input.isAlive ?? isProcessAlive)(marker.pid)) rmSync(file, { force: true });
  } catch {
    // No marker: the process removed it on its way out.
  }
}

/**
 * Records that this process began a requested shutdown, so being killed before it finishes is not
 * reported. Synchronous, so it lands before anything that could hang.
 */
export function recordMarkerStopping(home: string, name: string): void {
  const file = markerPath(home, name);
  try {
    const marker = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (marker.pid !== process.pid || marker.stoppingAt) return;
    writeFileSync(file, JSON.stringify({ ...marker, stoppingAt: new Date().toISOString() }));
  } catch {
    // No marker of this process: nothing would report its end anyway.
  }
}

/**
 * Records that the computer is ending the user's session (shut down, restart, sign out), so no run
 * it takes down reports a crash, whichever process it belongs to. Windows tells only the app's
 * windows, then ends every process without a signal, the daemon included, and a shut down with
 * Fast Startup keeps the uptime that `claimRunningMarker` checks. Synchronous: the system may end
 * the process as soon as the app has handled the notice.
 */
export function recordSessionEnding(home: string): void {
  const directory = crashReportsDirectory(home);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".running"));
  } catch {
    return;
  }
  const stoppingAt = new Date().toISOString();
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const marker = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (marker.stoppingAt) continue;
      writeFileSync(file, JSON.stringify({ ...marker, stoppingAt }));
    } catch {
      // Unreadable: the next start reads it as no marker, so it reports nothing either.
    }
  }
}

/**
 * Writes how a process ended into the marker it left behind, so its next run reports the signal or
 * exit code. A process killed outright cannot say how it ended; the supervisor that started it can.
 * Synchronous, so it lands before the supervisor starts the next run. A marker that is gone or
 * belongs to another process means the process exited on its own and reported itself.
 */
export function recordMarkerExit(input: {
  readonly home: string;
  readonly name: string;
  readonly pid: number;
  readonly exit: NonNullable<RunningMarker["exit"]>;
}): void {
  const file = markerPath(input.home, input.name);
  try {
    const marker = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (marker.pid !== input.pid) return;
    writeFileSync(file, JSON.stringify({ ...marker, exit: input.exit }));
  } catch {
    // No marker: the process removed it on its way out.
  }
}

export function describeUncleanShutdown(label: string, marker: RunningMarker): string {
  const version = marker.version ? `version ${marker.version}, ` : "";
  const run = `${label} (${version}process ${marker.pid}, started ${marker.startedAt})`;
  if (marker.exit?.signal) return `${run} was killed by ${marker.exit.signal}`;
  if (marker.exit) return `${run} ended with exit code ${marker.exit.code}`;
  return `${run} ended without exiting`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
