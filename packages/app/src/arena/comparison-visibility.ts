import type { ArenaComparisonDiff, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

const diffReadyStates = new Set([
  "awaiting_vote",
  "awaiting_stop_resolution",
  "applying",
  "canonicalizing",
  "cleanup_pending",
  "complete",
  "discarding",
  "discarded",
  "application_failed",
  "canonicalization_failed",
]);

export function hasBattleDiff(diff: ArenaComparisonDiff | undefined): diff is ArenaComparisonDiff {
  return diff !== undefined && (!diff.treesEqual || diff.files.length > 0);
}

export function canRequestBattleDiff(state: string): boolean {
  return diffReadyStates.has(state);
}

/**
 * Whether the battle shows its summary and changes once both sides are final. A battle the engine's
 * restart cut off has nothing to compare until it resumes.
 */
export function canReviewBattle(turn: ArenaSnapshot["turn"]): boolean {
  return turn !== undefined && !turn.canResumeBattle && canRequestBattleDiff(turn.state);
}
