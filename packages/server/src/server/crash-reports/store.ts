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
  })
  .strict();
export type StoredCrashReport = z.infer<typeof storedCrashReportSchema>;

export interface CrashInput {
  readonly process: CrashReport["process"];
  readonly kind: CrashReport["kind"];
  readonly message: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export function crashReportsDirectory(home: string): string {
  return path.join(home, DIRECTORY);
}

export function operatingSystemName(): string {
  return `${os.type()} ${os.release()} ${os.arch()}`.slice(0, 128);
}

/** The last lines of a log, oldest first, read without loading the whole file. */
export function readLogTail(logPath: string): string[] {
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
      .slice(-feedbackLogTailMaximumLines)
      .map((line) => line.slice(0, feedbackLogLineMaximumLength));
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function recordCrashReport(input: {
  readonly home: string;
  readonly crash: CrashInput;
  readonly appVersion: string | null;
  readonly logPath?: string;
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
      logTail: input.logPath ? readLogTail(input.logPath) : [],
    });
    const directory = crashReportsDirectory(input.home);
    mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${report.id}.json`);
    // A report half written when the process died would be unreadable, so it appears whole.
    writeFileSync(`${target}.tmp`, JSON.stringify(report));
    renameSync(`${target}.tmp`, target);
    pruneCrashReports(input.home);
    return report;
  } catch {
    return null;
  }
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

const runningMarkerSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string().nullable(),
  startedAt: z.iso.datetime(),
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
 */
export function claimRunningMarker(input: {
  readonly home: string;
  readonly name: string;
  readonly version: string | null;
  readonly isAlive?: (pid: number) => boolean;
}): RunningMarker | null {
  const file = markerPath(input.home, input.name);
  let previous: RunningMarker | null = null;
  try {
    previous = runningMarkerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    previous = null;
  }
  const isAlive = input.isAlive ?? isProcessAlive;
  const ended = previous !== null && previous.pid !== process.pid && !isAlive(previous.pid);
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

export function describeUncleanShutdown(label: string, marker: RunningMarker): string {
  const version = marker.version ? `version ${marker.version}, ` : "";
  return `${label} (${version}process ${marker.pid}, started ${marker.startedAt}) ended without exiting`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
