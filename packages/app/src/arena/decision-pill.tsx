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
import { arenaSetupStatus } from "./transition-progress";
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
  return (
    <ArenaSideChoiceButton
      side={side}
      kind="vote"
      loading={pendingVote}
      disabled={pending || !canChoose}
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
  const setupStatus = arenaSetupStatus(snapshot.turn);
  const stopped = phase.kind === "awaiting_stop_resolution";
  const showChoices = phase.kind === "running" || phase.kind === "awaiting_vote" || stopped;
  const visible = isArenaBattleOnScreen(snapshot) && showChoices && setupStatus === null;
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
        {phase.kind === "running"
          ? arenaRunningDecisionOrder(phase).map((choice) =>
              choice === "stop" ? (
                <BattleStopDecision key="stop" phase={phase} actions={actions} />
              ) : (
                <BattlePaneDecision key={choice} side={choice} phase={phase} actions={actions} />
              ),
            )
          : null}
        {phase.kind !== "running" ? (
          <>
            <BattlePaneDecision side="a" phase={phase} actions={actions} />
            {phase.kind === "awaiting_vote" ? <VoteDecision actions={actions} /> : null}
            {stopped ? <DiscardDecision actions={actions} /> : null}
            <BattlePaneDecision side="b" phase={phase} actions={actions} />
          </>
        ) : null}
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
