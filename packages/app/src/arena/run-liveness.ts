import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

export const POSSIBLY_STALLED_AFTER_MS = 90_000;

export function isArenaRunPossiblyStalled(run: ArenaRun, now: number): boolean {
  if (run.runState !== "pending") return false;
  const activity = run.lastEventAt ?? run.firstEventAt ?? run.startedAt;
  if (typeof activity !== "string") return false;
  const activityAt = Date.parse(activity);
  return Number.isFinite(activityAt) && now - activityAt >= POSSIBLY_STALLED_AFTER_MS;
}
