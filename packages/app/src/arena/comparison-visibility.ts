import type {
  ArenaComparisonDiff,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";

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

export type BattleReviewPhase =
  | { kind: "none" }
  /** One side has a result and the other is still working: its changes alone, no summary yet. */
  | { kind: "partial"; finished: ArenaSide; waitingFor: ArenaSide }
  | { kind: "full" };

function settled(run: ArenaRun | undefined): boolean {
  return run !== undefined && run.runState !== "pending";
}

// A side working again after a reply keeps its last result's commit on the run, so the state
// decides, not the commit alone.
function hasResult(run: ArenaRun | undefined): boolean {
  return settled(run) && Boolean(run?.finalCommit);
}

// A run reads complete a moment before the engine records its commit; until then the side is
// still working, so the review stays on the first result instead of dropping out for that moment.
function finishing(run: ArenaRun | undefined): boolean {
  return run?.runState === "pending" || (run?.runState === "complete" && !run.finalCommit);
}

/**
 * The turn's comparison, keyed by the commits it compares. A side finishing a reply reads complete
 * while it still carries its previous result's commit, so the comparison fetched at that moment is
 * of the old result; the new commit changes the key and fetches it again.
 */
export function arenaDiffQueryKey(
  serverId: string,
  agentId: string,
  turnId: string,
  runA: ArenaRun | undefined,
  runB: ArenaRun | undefined,
) {
  const commits = `${runA?.finalCommit ?? "-"}:${runB?.finalCommit ?? "-"}`;
  return ["arena", "diff", serverId, agentId, turnId, commits];
}

/** The commits a comparison compares; a side still working stands in as the base. */
export function comparisonRevision(diff: ArenaComparisonDiff): string {
  return `${diff.a.commit}:${diff.b.commit}`;
}

/**
 * What the card can review: both results once both sides settle, or the first result alone
 * while the other side still works, so the voter can read it before deciding early.
 */
export function battleReviewPhase(
  turn: ArenaSnapshot["turn"],
  runA: ArenaRun | undefined,
  runB: ArenaRun | undefined,
): BattleReviewPhase {
  if (!turn) return { kind: "none" };
  const working = turn.state === "running" || turn.state === "finalizing";
  if (settled(runA) && settled(runB)) {
    // Both results are in before the turn moves on to the vote; the review stays up through
    // that rather than vanishing for a moment and coming back.
    const ready = canReviewBattle(turn) || (working && hasResult(runA) && hasResult(runB));
    if (ready) return { kind: "full" };
  }
  if (!working) return { kind: "none" };
  if (hasResult(runA) && finishing(runB))
    return { kind: "partial", finished: "a", waitingFor: "b" };
  if (hasResult(runB) && finishing(runA))
    return { kind: "partial", finished: "b", waitingFor: "a" };
  return { kind: "none" };
}
