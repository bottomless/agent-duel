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
 * Where the turn's difference summary stands. The engine marks the turn `running` and computes the
 * git evidence before it writes the comparison record, so the review mounts with no record yet; the
 * turn's own state stands in until the record exists. Reading only the record opened every review
 * on Changes, because the review keeps the tab it opened on.
 */
export function battleSummaryStatus(
  comparison: ArenaSnapshot["comparison"],
  comparisonState: NonNullable<ArenaSnapshot["turn"]>["comparisonState"],
): { available: boolean; pending: boolean; failed: boolean } {
  // A stopped battle never gets a summary.
  if (comparisonState === "skipped") return { available: false, pending: false, failed: false };
  const state = comparison?.state ?? comparisonState;
  const pending = state === "pending" || state === "running";
  const failed = state === "failed";
  return { available: pending || failed || Boolean(comparison?.output), pending, failed };
}
