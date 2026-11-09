import { useTranslation } from "react-i18next";
import { useCallback, useMemo, useState } from "react";
import type {
  ArenaComparisonDiff,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { arenaSizeErrorOr, isArenaSizeError } from "./chat-too-large";
import { arenaChangesRows } from "./changes-rows";
import { BattleReview } from "./battle-review";
import {
  arenaDiffQueryKey,
  battleReviewPhase,
  battleSummaryStatus,
  type BattleReviewPhase,
} from "./comparison-visibility";
import { isArenaBattleOnScreen } from "./summary-anchor";
import type { ArenaBattleActions } from "./use-battle-actions";

// The same key the side panel and the summary fetch, so no view adds a request. The first
// result alone is keyed apart, so the comparison is fetched again once the other side lands.
function useBattleDiff(
  serverId: string,
  agentId: string,
  turnId: string,
  runA: ArenaRun | undefined,
  runB: ArenaRun | undefined,
  phase: BattleReviewPhase,
) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return useFetchQuery({
    queryKey: [
      ...arenaDiffQueryKey(serverId, agentId, turnId, runA, runB),
      ...(phase.kind === "partial" ? [`partial:${phase.finished}`] : []),
    ],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error(t("arena.connectionUnavailable"));
      try {
        return await client.arenaDiff(agentId, turnId);
      } catch (error) {
        throw arenaSizeErrorOr(error);
      }
    },
    enabled: Boolean(client),
    // A comparison too large to send is refused the same way every time.
    retry: (failures, error) => failures < 2 && !isArenaSizeError(error),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });
}

interface ShownBattleDiff {
  diff: ArenaComparisonDiff;
  /** The side still working when this diff was fetched; its column is a placeholder. */
  waitingFor: ArenaSide | null;
}

/** The review once a result is in, fed from the same diff query the summary uses. */
function BattleJudging({
  serverId,
  agentId,
  turnId,
  comparison,
  comparisonState,
  decided,
  runA,
  runB,
  phase,
  retrying,
  onRetry,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  comparison: ArenaSnapshot["comparison"];
  comparisonState: NonNullable<ArenaSnapshot["turn"]>["comparisonState"];
  /** The turn has a resolution, which closes its summary's scope. */
  decided: boolean;
  runA: ArenaRun | undefined;
  runB: ArenaRun | undefined;
  phase: Exclude<BattleReviewPhase, { kind: "none" }>;
  retrying: boolean;
  onRetry: () => void;
}) {
  // A turn's comparison is pending from its creation, which while one side still works would
  // read as a summary on its way; nothing starts until both sides finish.
  const summary =
    phase.kind === "partial"
      ? { available: false, pending: false, failed: false }
      : battleSummaryStatus(comparison, comparisonState, decided);
  const diffQuery = useBattleDiff(serverId, agentId, turnId, runA, runB, phase);
  const refetchDiff = diffQuery.refetch;
  const retryDiff = useCallback(() => {
    void refetchDiff();
  }, [refetchDiff]);
  // When the other side lands, the full comparison is fetched under a new key and arrives a moment
  // later. Until it does, the review keeps the first result it was showing, with the placeholder
  // column it was fetched with, rather than collapsing every open diff into a spinner.
  const phaseWaitingFor = phase.kind === "partial" ? phase.waitingFor : null;
  const live: ShownBattleDiff | null = diffQuery.data
    ? { diff: diffQuery.data, waitingFor: phaseWaitingFor }
    : null;
  const [held, setHeld] = useState<ShownBattleDiff | null>(null);
  if (live && (live.diff !== held?.diff || live.waitingFor !== held.waitingFor)) setHeld(live);
  const shown = live ?? (held?.diff.turnID === turnId ? held : null);
  const diff = shown?.diff;
  const rows = useMemo(() => arenaChangesRows(diff), [diff]);
  return (
    <BattleReview
      serverId={serverId}
      agentId={agentId}
      turnId={turnId}
      summaryAvailable={summary.available}
      summaryPending={summary.pending}
      summaryFailed={summary.failed}
      waitingFor={shown ? shown.waitingFor : phaseWaitingFor}
      comparison={comparison}
      retrying={retrying}
      onRetry={onRetry}
      diff={diff}
      diffError={diffQuery.error}
      rows={rows}
      onRetryDiff={retryDiff}
      retryingDiff={diffQuery.isFetching}
    />
  );
}

/**
 * The live battle's review, in the chat under its answers, the same as a decided battle's under
 * Show battle. Nothing until a result is in.
 */
export function ArenaLiveReview({
  serverId,
  agentId,
  snapshot,
  actions,
}: {
  serverId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  actions: ArenaBattleActions;
}) {
  const turn = isArenaBattleOnScreen(snapshot) ? snapshot.turn : undefined;
  const runA = snapshot.runs.find((run) => run.side === "a");
  const runB = snapshot.runs.find((run) => run.side === "b");
  const phase = battleReviewPhase(turn, runA, runB);
  if (!turn || phase.kind === "none") return null;
  return (
    <BattleJudging
      serverId={serverId}
      agentId={agentId}
      turnId={turn.id}
      comparison={snapshot.comparison}
      comparisonState={turn.comparisonState}
      decided={turn.resolution !== undefined}
      runA={runA}
      runB={runB}
      phase={phase}
      retrying={actions.pendingAction?.kind === "retry_comparison"}
      onRetry={actions.retryComparison}
    />
  );
}
