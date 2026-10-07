import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaRunningTool, isArenaRunPossiblyStalled } from "./run-liveness";

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
        return "Retrying";
      if (isArenaRunPossiblyStalled(run, now)) {
        const tool = arenaRunningTool(run);
        if (tool === "command") return "Running a command";
        if (tool === "tool") return "Running a tool";
        return "No recent activity";
      }
      return "Working";
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
