import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaResolutionStatus, arenaSetupStatus } from "./transition-progress";

export type TransitionPhase = "setup" | "resolution";
type Turn = NonNullable<ArenaSnapshot["turn"]>;
export type TimelineTurn = Pick<Turn, "state" | "activeOperations" | "operationProgress">;
type Progress = NonNullable<Turn["operationProgress"]>[number];
type Operation = Progress["operation"];

export interface TransitionTimelineRow {
  id: string;
  label: string;
  state: Progress["state"] | "waiting";
  startedAt: number | null;
  finishedAt: number | null;
}

const SETUP_OPERATIONS = new Set<Operation>([
  "preparing_workspaces",
  "copying_environment",
  "releasing_environment",
]);

const LABELS: Record<Operation, { running: string; completed: string }> = {
  preparing_workspaces: { running: "Preparing workspaces", completed: "Workspaces prepared" },
  copying_environment: {
    running: "Copying files and dependencies",
    completed: "Files and dependencies copied",
  },
  releasing_environment: {
    running: "Releasing the previous environment",
    completed: "Previous environment released",
  },
  preserving_results: { running: "Saving battle results", completed: "Battle results saved" },
  checking_workspace: {
    running: "Checking workspace changes",
    completed: "Workspace changes checked",
  },
  applying_changes: {
    running: "Applying changes to your workspace",
    completed: "Changes applied to your workspace",
  },
  updating_conversation: {
    running: "Updating the conversation",
    completed: "Conversation updated",
  },
  releasing_loser: {
    running: "Releasing the other environment",
    completed: "Other environment released",
  },
};

export function transitionTimelineRows({
  phase,
  turn,
}: {
  phase: TransitionPhase;
  turn: TimelineTurn | undefined;
}): TransitionTimelineRow[] {
  const setup = phase === "setup";
  const progress = (turn?.operationProgress ?? []).filter(
    (entry) => SETUP_OPERATIONS.has(entry.operation) === setup,
  );
  const rows: TransitionTimelineRow[] = progress.map((entry) => ({
    id: entry.operation,
    label:
      entry.state === "completed"
        ? LABELS[entry.operation].completed
        : LABELS[entry.operation].running,
    state: entry.state,
    startedAt: entry.startedAt,
    finishedAt: entry.state === "running" ? null : entry.finishedAt,
  }));
  if (rows.length === 0) {
    const fallback = setup ? arenaSetupStatus(turn) : arenaResolutionStatus(turn);
    rows.push({
      id: "starting",
      label: fallback ?? "Preparing the transition",
      state: "running",
      startedAt: null,
      finishedAt: null,
    });
  }
  rows.push({
    id: "ready",
    label: setup ? "Agents ready" : "Ready for your next prompt",
    state: "waiting",
    startedAt: null,
    finishedAt: null,
  });
  return rows;
}

export function transitionDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
