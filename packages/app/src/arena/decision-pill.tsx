import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ARENA_MAX_CONTENT_WIDTH } from "@/constants/layout";
import { Button } from "@/components/ui/button";
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
import { BATTLE_RAIL } from "./battle-layout";

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

/** Whether the decision row shows for this snapshot: a battle on screen with a choice to make. */
export function arenaDecisionRowVisible(snapshot: ArenaSnapshot): boolean {
  const phase = arenaDecisionPhase(snapshot);
  const showChoices =
    phase.kind === "running" ||
    phase.kind === "awaiting_vote" ||
    phase.kind === "awaiting_stop_resolution";
  return isArenaBattleOnScreen(snapshot) && showChoices;
}

/** The choices themselves, centred between the two answers. */
function DecisionChoices({
  phase,
  actions,
  onLayout,
}: {
  phase: ArenaDecisionPhase;
  actions: ArenaBattleActions;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const stopped = phase.kind === "awaiting_stop_resolution";
  const interrupted = phase.kind === "awaiting_vote" && phase.canResume;
  return (
    <View style={styles.choices} onLayout={onLayout} testID="arena-battle-choice-row">
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
      {/* A failed side shows Accept in its Choose's place, or nothing if its result was not saved,
          and each failed pane keeps its Retry. */}
      {phase.kind !== "running" && !interrupted ? (
        <>
          <BattlePaneDecision side="a" phase={phase} actions={actions} />
          {phase.kind === "awaiting_vote" && phase.canTie ? (
            <VoteDecision actions={actions} />
          ) : null}
          {stopped || (phase.kind === "awaiting_vote" && phase.canDiscard) ? (
            <DiscardDecision actions={actions} />
          ) : null}
          <BattlePaneDecision side="b" phase={phase} actions={actions} />
        </>
      ) : null}
    </View>
  );
}

/**
 * The battle's bottom row, outside the transcript scroller so the decision stays in view: a folded
 * review's tabs at the start, the choices centred between the two answers, and the way to reply
 * at the end while the composer is put away.
 */
export function ArenaDecisionPill({
  serverId,
  agentId,
  snapshot,
  onHeightChange,
  onAskFollowUp,
  docked = false,
}: {
  serverId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  onHeightChange: (height: number) => void;
  /** Shown while the composer is put away; brings it back. */
  onAskFollowUp?: () => void;
  /** In the composer's place rather than floating above it. */
  docked?: boolean;
}) {
  const { t } = useTranslation();
  const actions = useArenaBattleActions(serverId, agentId, snapshot.turn);
  const phase = arenaDecisionPhase(snapshot);
  const hint = decisionHint(phase);
  const visible = arenaDecisionRowVisible(snapshot);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );
  const fit = useRowFit();
  // Ask a follow-up sits beside the choices only while an equal space on the other side still
  // keeps them centred; otherwise it drops under them instead of covering Choose B.
  const besideChoices = !onAskFollowUp || fit.fits;
  useEffect(() => {
    if (!visible) onHeightChange(0);
    return () => onHeightChange(0);
  }, [onHeightChange, visible]);
  if (!visible) return null;

  return (
    <View
      style={docked ? styles.dock : styles.container}
      onLayout={handleLayout}
      pointerEvents="box-none"
      testID="arena-decision-pill"
    >
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <View
        style={[styles.row, !besideChoices && styles.stacked]}
        onLayout={fit.onRowLayout}
        pointerEvents="box-none"
      >
        {besideChoices ? <View style={styles.start} pointerEvents="box-none" /> : null}
        <DecisionChoices phase={phase} actions={actions} onLayout={fit.onChoicesLayout} />
        <View style={besideChoices ? [styles.start, styles.end] : null} pointerEvents="box-none">
          {onAskFollowUp ? (
            <View onLayout={fit.onFollowUpLayout}>
              <Button
                variant="outline"
                size="md"
                style={styles.followUp}
                textStyle={styles.followUpText}
                onPress={onAskFollowUp}
                testID="arena-ask-follow-up"
              >
                {t("arena.askFollowUp")}
              </Button>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const ROW_GAP = 16;

/**
 * Measures the row, the choices and Ask a follow-up. The choices fit centred with the button
 * beside them when the row holds the choices plus the button's width (and the gap) on both sides.
 */
function useRowFit() {
  const [row, setRow] = useState(0);
  const [choices, setChoices] = useState(0);
  const [followUp, setFollowUp] = useState(0);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRow(event.nativeEvent.layout.width - 2 * BATTLE_RAIL);
  }, []);
  const onChoicesLayout = useCallback((event: LayoutChangeEvent) => {
    setChoices(event.nativeEvent.layout.width);
  }, []);
  const onFollowUpLayout = useCallback((event: LayoutChangeEvent) => {
    setFollowUp(event.nativeEvent.layout.width);
  }, []);
  const measured = row > 0 && choices > 0 && followUp > 0;
  const fits = !measured || row >= choices + 2 * (followUp + ROW_GAP);
  return { fits, onRowLayout, onChoicesLayout, onFollowUpLayout };
}

const styles = StyleSheet.create((theme) => ({
  // Above the composer, over the end of the transcript. Opaque, so the transcript scrolls under it.
  container: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  // In the composer's place while the composer is put away.
  dock: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4] + theme.spacing[1],
    gap: theme.spacing[2],
  },
  row: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: BATTLE_RAIL,
    gap: ROW_GAP,
  },
  // Too narrow for the button beside the choices: it goes under them, both centred.
  stacked: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  // The two ends share the space evenly, so the choices stay centred between the answers.
  start: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  end: {
    justifyContent: "flex-end",
  },
  choices: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  followUp: {
    height: 40,
    borderRadius: theme.borderRadius.lg,
  },
  followUpText: {
    fontWeight: theme.fontWeight.semibold,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
