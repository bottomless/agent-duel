import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  ArenaRunningPillButton,
  ArenaSideChoiceButton,
  DiscardDecision,
  ResumeDecision,
  VoteDecision,
} from "./decision-bar";
import {
  arenaDecisionPhase,
  arenaRunningDecisionHint,
  arenaRunningDecisionOrder,
  type ArenaDecisionPhase,
} from "./decision-state";
import { isArenaBattleOnScreen } from "./summary-anchor";
import { useArenaBattleActions, type ArenaBattleActions } from "./use-battle-actions";

function BattlePaneDecision({
  side,
  phase,
  actions,
}: {
  side: ArenaSide;
  phase: ArenaDecisionPhase;
  actions: ArenaBattleActions;
}) {
  const { pending, pendingAction } = actions;
  const handleChoose = useCallback(() => {
    void actions.choose(side);
  }, [actions, side]);
  const handlePickEarly = useCallback(() => {
    void actions.pickEarly(side);
  }, [actions, side]);
  const handleAccept = useCallback(() => {
    void actions.acceptFailed(side);
  }, [actions, side]);
  const pendingVote = pendingAction?.kind === "vote" && pendingAction.vote === side;

  if (phase.kind === "running") {
    const canPick = side === "a" ? phase.canPickA : phase.canPickB;
    if (!canPick) return null;
    return (
      <ArenaSideChoiceButton
        side={side}
        kind="early"
        loading={pendingVote}
        disabled={pending}
        onPress={handlePickEarly}
        testID={`arena-pick-early-${side}-now`}
      />
    );
  }

  if (phase.kind === "awaiting_stop_resolution") {
    return <BattlePaneKeepDecision side={side} phase={phase} actions={actions} />;
  }

  if (phase.kind !== "awaiting_vote") return null;
  const canChoose = side === "a" ? phase.canChooseA : phase.canChooseB;
  if (!canChoose) {
    const canAccept = side === "a" ? phase.canAcceptA : phase.canAcceptB;
    if (!canAccept) return null;
    return (
      <ArenaSideChoiceButton
        side={side}
        kind="accept"
        loading={pendingVote}
        disabled={pending}
        onPress={handleAccept}
        testID={`arena-accept-failed-${side}`}
      />
    );
  }
  return (
    <ArenaSideChoiceButton
      side={side}
      kind="vote"
      loading={pendingVote}
      disabled={pending}
      onPress={handleChoose}
      testID={`arena-choose-${side}`}
    />
  );
}

function BattlePaneKeepDecision({
  side,
  phase,
  actions,
}: {
  side: ArenaSide;
  phase: Extract<ArenaDecisionPhase, { kind: "awaiting_stop_resolution" }>;
  actions: ArenaBattleActions;
}) {
  const { pending, pendingAction } = actions;
  const resolution = side === "a" ? "apply_a" : "apply_b";
  const canKeep = side === "a" ? phase.canKeepA : phase.canKeepB;
  const failed = side === "a" ? phase.failedA : phase.failedB;
  const handleKeep = useCallback(() => {
    // A failed side's work can be partial, so it asks first, as Accept does.
    void (failed ? actions.keepFailed(side) : actions.resolveStop(resolution));
  }, [actions, failed, resolution, side]);
  return (
    <ArenaSideChoiceButton
      side={side}
      kind="keep"
      loading={pendingAction?.kind === "resolve_stop" && pendingAction.resolution === resolution}
      disabled={pending || !canKeep}
      onPress={handleKeep}
      testID={`arena-stopped-keep-${side}`}
    />
  );
}

function BattleStopDecision({
  phase,
  actions,
}: {
  phase: Extract<ArenaDecisionPhase, { kind: "running" }>;
  actions: ArenaBattleActions;
}) {
  const { t } = useTranslation();
  const handleStop = useCallback(() => {
    void actions.stop();
  }, [actions]);
  return (
    <ArenaRunningPillButton
      hoverSide={null}
      label={t("arena.stop")}
      loading={actions.pendingAction?.kind === "stop"}
      disabled={actions.pending || !phase.canStop}
      onPress={handleStop}
      accessibilityLabel={t("arena.stopBattle")}
      testID="arena-stop-battle"
    />
  );
}

function stoppedHint(phase: Extract<ArenaDecisionPhase, { kind: "awaiting_stop_resolution" }>) {
  if (phase.failedA && phase.failedB) return i18n.t("arena.stoppedBothFailed");
  if (phase.failedA || phase.failedB) {
    return i18n.t("arena.stoppedFailedSide", { side: phase.failedA ? "A" : "B" });
  }
  return i18n.t("arena.stoppedChoose");
}

/** The line above the pill that says why the usual choices changed, if they did. */
function decisionHint(phase: ArenaDecisionPhase): string | null {
  if (phase.kind === "running") return arenaRunningDecisionHint(phase);
  if (phase.kind === "awaiting_stop_resolution") return stoppedHint(phase);
  if (phase.kind !== "awaiting_vote") return null;
  if (phase.canResume) return i18n.t("arena.closedBattle");
  if (phase.failedSide) {
    const side = phase.failedSide.toUpperCase();
    const canAccept = phase.failedSide === "a" ? phase.canAcceptA : phase.canAcceptB;
    if (canAccept) return i18n.t("arena.failedSideAccept", { side });
    return i18n.t("arena.failedSide", { side, other: phase.failedSide === "a" ? "B" : "A" });
  }
  if (!phase.bothFailed) return null;
  if (phase.canAcceptA || phase.canAcceptB) return i18n.t("arena.bothFailedAccept");
  return phase.canRetry ? i18n.t("arena.bothFailedRetry") : i18n.t("arena.bothFailed");
}

/**
 * The pill is empty only at a vote with no side to take, a Choose or an Accept in a failed side's
 * place; then the failure line's Discard is the only choice and an empty pill would sit under it.
 */
function pillHasChoice(phase: ArenaDecisionPhase): boolean {
  if (phase.kind !== "awaiting_vote" || phase.canResume) return true;
  return phase.canChooseA || phase.canChooseB || phase.canAcceptA || phase.canAcceptB;
}

/**
 * At the vote Discard sits at the end of the line that says a side failed rather than among the
 * vote's choices, so it shows only when that line explains why the battle can be thrown away.
 * After a stop or a restart it stays in the pill.
 */
function DecisionHintRow({
  phase,
  actions,
}: {
  phase: ArenaDecisionPhase;
  actions: ArenaBattleActions;
}) {
  const hint = decisionHint(phase);
  if (!hint) return null;
  const discard = phase.kind === "awaiting_vote" && !phase.canResume && phase.canDiscard;
  return (
    <View style={styles.hintRow}>
      <Text style={styles.hint}>{hint}</Text>
      {discard ? <DiscardDecision actions={actions} placement="hint" /> : null}
    </View>
  );
}

/** Lives outside the transcript scroller so the decision stays above the composer. */
export function ArenaDecisionPill({
  serverId,
  agentId,
  snapshot,
  onHeightChange,
}: {
  serverId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  onHeightChange: (height: number) => void;
}) {
  useTranslation();
  const actions = useArenaBattleActions(serverId, agentId, snapshot.turn);
  const phase = arenaDecisionPhase(snapshot);
  const stopped = phase.kind === "awaiting_stop_resolution";
  const interrupted = phase.kind === "awaiting_vote" && phase.canResume;
  const showChoices = phase.kind === "running" || phase.kind === "awaiting_vote" || stopped;
  const visible = isArenaBattleOnScreen(snapshot) && showChoices;
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );
  useEffect(() => {
    if (!visible) onHeightChange(0);
    return () => onHeightChange(0);
  }, [onHeightChange, visible]);
  if (!visible) return null;

  return (
    <View
      style={styles.container}
      onLayout={handleLayout}
      pointerEvents="box-none"
      testID="arena-decision-pill"
    >
      <DecisionHintRow phase={phase} actions={actions} />
      {pillHasChoice(phase) ? (
        <View style={styles.pill} testID="arena-battle-choice-row">
          {phase.kind === "running"
            ? arenaRunningDecisionOrder(phase).map((choice) =>
                choice === "stop" ? (
                  <BattleStopDecision key="stop" phase={phase} actions={actions} />
                ) : (
                  <BattlePaneDecision key={choice} side={choice} phase={phase} actions={actions} />
                ),
              )
            : null}
          {interrupted ? (
            <>
              <ResumeDecision actions={actions} />
              <DiscardDecision actions={actions} />
            </>
          ) : null}
          {/* A failed side shows Accept in its Choose's place, or nothing if its result was not
              saved, and each failed pane keeps its Retry. */}
          {phase.kind !== "running" && !interrupted ? (
            <>
              <BattlePaneDecision side="a" phase={phase} actions={actions} />
              {phase.kind === "awaiting_vote" && phase.canTie ? (
                <VoteDecision actions={actions} />
              ) : null}
              {stopped ? <DiscardDecision actions={actions} /> : null}
              <BattlePaneDecision side="b" phase={phase} actions={actions} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    backgroundColor: "transparent",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
  },
  pill: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  hintRow: {
    maxWidth: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: theme.spacing[2],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
