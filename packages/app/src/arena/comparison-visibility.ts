import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";

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
