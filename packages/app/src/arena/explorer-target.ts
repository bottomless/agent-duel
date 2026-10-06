import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

/** A contestant worktree the explorer can browse while the battle owns it. */
export interface ArenaExplorerTarget {
  side: ArenaSide;
  worktree: string;
}

const OPTION_ID_PREFIX = "arena-agent:";

// Contestant worktrees appear when the turn reaches `worktrees_ready` and are
// removed by cleanup on the way to `complete`/`discarded`. The states in between
// are exactly the window where the directories are on disk — including the failed
// ones, which is when looking inside them is most useful.
const WORKTREES_ON_DISK_STATES: ReadonlySet<string> = new Set([
  "worktrees_ready",
  "running",
  "early_selected",
  "finalizing",
  "awaiting_vote",
  "applying",
  "canonicalizing",
  "stopping",
  "awaiting_stop_resolution",
  "finalization_failed",
  "application_failed",
  "canonicalization_failed",
  "interrupted_recovery",
]);

const SIDES: readonly ArenaSide[] = ["a", "b"];

export function arenaExplorerOptionId(side: ArenaSide): string {
  return `${OPTION_ID_PREFIX}${side}`;
}

export function parseArenaExplorerOptionId(optionId: string): ArenaSide | null {
  return SIDES.find((side) => arenaExplorerOptionId(side) === optionId) ?? null;
}

export function arenaExplorerOptionLabel(side: ArenaSide): string {
  return `Current agent ${side.toUpperCase()}`;
}

export function selectArenaExplorerTargets(
  snapshot: ArenaSnapshot | undefined,
): ArenaExplorerTarget[] {
  const state = snapshot?.turn?.state;
  if (!snapshot || !state || !WORKTREES_ON_DISK_STATES.has(state)) {
    return [];
  }
  return SIDES.flatMap((side) => {
    const worktree = snapshot.runs.find((run) => run.side === side)?.worktree.trim();
    return worktree ? [{ side, worktree }] : [];
  });
}

export function resolveArenaExplorerTarget(
  targets: readonly ArenaExplorerTarget[],
  side: ArenaSide | null,
): ArenaExplorerTarget | null {
  return side === null ? null : (targets.find((target) => target.side === side) ?? null);
}
