import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaLongRunningTool, isArenaRunPossiblyStalled } from "./run-liveness";

const RETRY_MESSAGES = new Set([
  "Waiting for network",
  "Continuing after response limit",
  "Continuing after model timeout",
]);

type ArenaRunTiming = Pick<ArenaRun, "runState" | "startedAt" | "completedAt" | "durationMs">;

function parseTime(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How long a contestant has worked, or null before it starts.
 *
 * A settled run reports the engine's own duration so the number stops moving
 * the moment the run finalizes; a pending run counts from when it started.
 */
export function arenaRunElapsedMs(run: ArenaRunTiming, now: number): number | null {
  if (typeof run.durationMs === "number" && run.durationMs >= 0) return run.durationMs;
  const startedAt = parseTime(run.startedAt);
  if (startedAt === null) return null;
  const completedAt = parseTime(run.completedAt);
  if (completedAt !== null) return Math.max(0, completedAt - startedAt);
  if (run.runState !== "pending") return null;
  return Math.max(0, now - startedAt);
}

export function arenaRunStatusLabel(run: ArenaRun, now: number): string {
  switch (run.runState) {
    case "pending":
      if (run.questions?.length) return "Waiting for your answer";
      if (run.permissions?.length) return "Waiting for permission";
      if (
        typeof run.status === "object" &&
        run.status !== null &&
        "type" in run.status &&
        run.status.type === "retry"
      )
        // The engine's neutral recovery and offline-wait messages preserve blinding.
        return "message" in run.status &&
          typeof run.status.message === "string" &&
          RETRY_MESSAGES.has(run.status.message)
          ? run.status.message
          : "Retrying";
      switch (arenaLongRunningTool(run, now)) {
        case "command":
          return "Running a command";
        case "tool":
          return "Running a tool";
      }
      return isArenaRunPossiblyStalled(run, now) ? "No recent activity" : "Working";
    case "complete":
      return "Finished";
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Failed";
  }
}

export function arenaRunFilesLabel(diff: ArenaRun["diff"]): string | null {
  if (!diff) return null;
  return `${diff.files} ${diff.files === 1 ? "file" : "files"}`;
}
