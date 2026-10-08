import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  ARENA_OPERATION_LABELS,
  ARENA_SETUP_OPERATIONS,
  arenaResolutionStatus,
  arenaSetupStatus,
} from "./transition-progress";

export type TransitionPhase = "setup" | "resolution";
type Turn = NonNullable<ArenaSnapshot["turn"]>;
export type TimelineTurn = Pick<Turn, "state" | "activeOperations" | "operationProgress">;
type Progress = NonNullable<Turn["operationProgress"]>[number];

export interface TransitionTimelineRow {
  id: string;
  label: string;
  state: Progress["state"] | "waiting";
  startedAt: number | null;
  finishedAt: number | null;
}

export function transitionTimelineRows({
  phase,
  turn,
}: {
  phase: TransitionPhase;
  turn: TimelineTurn | undefined;
}): TransitionTimelineRow[] {
  const setup = phase === "setup";
  const progress = (turn?.operationProgress ?? []).filter(
    (entry) => ARENA_SETUP_OPERATIONS.has(entry.operation) === setup,
  );
  const rows: TransitionTimelineRow[] = progress.map((entry) => ({
    id: entry.operation,
    label:
      entry.state === "completed"
        ? ARENA_OPERATION_LABELS[entry.operation].completed
        : ARENA_OPERATION_LABELS[entry.operation].running,
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
