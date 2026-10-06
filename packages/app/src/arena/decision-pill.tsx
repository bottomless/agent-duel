import { useCallback, useEffect } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { ArenaSideChoiceButton, DiscardDecision, VoteDecision } from "./decision-bar";
import {
  arenaDecisionPhase,
  arenaRunningDecisionOrder,
  type ArenaDecisionPhase,
} from "./decision-state";
import { resolvingBattleLabels } from "./battle-result";
import { isArenaBattleOnScreen } from "./summary-anchor";
import { useArenaBattleActions, type ArenaBattleActions } from "./use-battle-actions";

function BattlePaneDecision({
  side,
  phase,
  actions,
  resolvingLabels,
}: {
  side: ArenaSide;
  phase: ArenaDecisionPhase;
  actions: ArenaBattleActions;
  resolvingLabels: Record<ArenaSide, string | null>;
}) {
  const { pending, pendingAction } = actions;
  const handleChoose = useCallback(() => {
    void actions.choose(side);
  }, [actions, side]);
  const handlePickEarly = useCallback(() => {
    void actions.pickEarly(side);
  }, [actions, side]);
  const sideLabel = side.toUpperCase();
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

  const resolutionInProgress = resolvingLabels.a !== null || resolvingLabels.b !== null;
  if (phase.kind !== "awaiting_vote" && !resolutionInProgress) return null;
  const canChoose =
    phase.kind === "awaiting_vote" && (side === "a" ? phase.canChooseA : phase.canChooseB);
  const resolvingLabel = resolvingLabels[side];
  return (
    <ArenaSideChoiceButton
      side={side}
      kind="vote"
      label={resolvingLabel ?? `Choose ${sideLabel}`}
      loading={Boolean(resolvingLabel) || pendingVote}
      disabled={resolutionInProgress || pending || !canChoose}
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
  const handleKeep = useCallback(() => {
    void actions.resolveStop(resolution);
  }, [actions, resolution]);
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
  const handleStop = useCallback(() => {
    void actions.stop();
  }, [actions]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.stopChoice}
      loading={actions.pendingAction?.kind === "stop"}
      disabled={actions.pending || !phase.canStop}
      onPress={handleStop}
      accessibilityLabel="Stop battle"
      testID="arena-stop-battle"
    >
      Stop
    </Button>
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
  const actions = useArenaBattleActions(serverId, agentId, snapshot.turn);
  const phase = arenaDecisionPhase(snapshot);
  const resolvingLabels = resolvingBattleLabels(snapshot.turn);
  const stopped = phase.kind === "awaiting_stop_resolution";
  const showChoices =
    phase.kind === "running" ||
    phase.kind === "awaiting_vote" ||
    stopped ||
    resolvingLabels.a !== null ||
    resolvingLabels.b !== null;
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
      {stopped ? <Text style={styles.hint}>Battle stopped · choose what to keep</Text> : null}
      <View style={styles.pill} testID="arena-battle-choice-row">
        {phase.kind === "running" ? (
          arenaRunningDecisionOrder(phase).map((choice) =>
            choice === "stop" ? (
              <BattleStopDecision key="stop" phase={phase} actions={actions} />
            ) : (
              <BattlePaneDecision
                key={choice}
                side={choice}
                phase={phase}
                actions={actions}
                resolvingLabels={resolvingLabels}
              />
            ),
          )
        ) : (
          <>
            <BattlePaneDecision
              side="a"
              phase={phase}
              actions={actions}
              resolvingLabels={resolvingLabels}
            />
            {phase.kind === "awaiting_vote" ? <VoteDecision actions={actions} /> : null}
            {stopped ? <DiscardDecision actions={actions} /> : null}
            <BattlePaneDecision
              side="b"
              phase={phase}
              actions={actions}
              resolvingLabels={resolvingLabels}
            />
          </>
        )}
      </View>
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
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  stopChoice: {
    minWidth: 96,
    borderRadius: theme.borderRadius.full,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
