import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { tint } from "@/styles/tint";
import type { Theme } from "@/styles/theme";
import { ArenaContentColumn } from "./content-column";
import {
  ARENA_PREPARING_WORKSPACES,
  arenaDecisionPhase,
  decisionBarShowsPhase,
  type ArenaDecisionPhase,
} from "./decision-state";
import { useArenaBattleActions, type ArenaBattleActions } from "./use-battle-actions";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The decision for one side: the vote, the early pick, or keeping that side after a stop.
 *
 * Two choices of equal weight, so neither can be the accent. The tint is the side's colour,
 * the blue and amber the diff's column headings use, so the button reads as picking that
 * column. Both sides share a width so the pair reads as one decision.
 */
export function ArenaSideChoiceButton({
  side,
  kind,
  label,
  loading,
  disabled,
  onPress,
  testID,
}: {
  side: ArenaSide;
  kind: "early" | "vote" | "keep";
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const sideLabel = side.toUpperCase();
  const isEarly = kind === "early";
  let buttonLabel = `Choose ${sideLabel}`;
  if (isEarly) buttonLabel = `Choose ${sideLabel} now`;
  if (kind === "keep") buttonLabel = `Keep ${sideLabel}`;
  return (
    <Button
      variant="secondary"
      size="sm"
      style={[styles.sideChoice, side === "a" ? styles.sideA : styles.sideB]}
      loading={loading}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
    >
      {label ?? buttonLabel}
    </Button>
  );
}

export function VoteDecision({ actions }: { actions: ArenaBattleActions }) {
  const { pending, pendingAction } = actions;
  const tie = useCallback(() => {
    void actions.tie();
  }, [actions]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.pillChoice}
      loading={pendingAction?.kind === "vote" && pendingAction.vote === "tie"}
      disabled={pending}
      onPress={tie}
      accessibilityLabel="Tie battle"
      accessibilityHint="A tie keeps Agent A's work."
      testID="arena-choose-tie"
    >
      Tie
    </Button>
  );
}

/** The third choice after a stop, between Keep A and Keep B. */
export function DiscardDecision({ actions }: { actions: ArenaBattleActions }) {
  const { pending, pendingAction } = actions;
  const discard = useCallback(() => {
    void actions.resolveStop("discard");
  }, [actions]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.pillChoice}
      loading={pendingAction?.kind === "resolve_stop" && pendingAction.resolution === "discard"}
      disabled={pending}
      onPress={discard}
      testID="arena-stopped-discard"
    >
      Discard
    </Button>
  );
}

function DetailWithCommands({ detail }: { detail: string }) {
  return (
    <>
      {detail.split("`").map((segment, index) =>
        index % 2 === 1 ? (
          <Text key={segment} style={styles.command}>
            {segment}
          </Text>
        ) : (
          segment
        ),
      )}
    </>
  );
}

function RetryResolutionDecision({
  phase,
  actions,
}: {
  phase: Extract<ArenaDecisionPhase, { kind: "retry_resolution" }>;
  actions: ArenaBattleActions;
}) {
  const { pending, pendingAction } = actions;
  return (
    <View style={styles.retry} testID="arena-resolution-retry-notice">
      <Text style={styles.error}>
        <DetailWithCommands detail={phase.detail} />
      </Text>
      <Button
        variant="outline"
        size="sm"
        loading={pendingAction?.kind === "retry_resolution"}
        disabled={pending}
        onPress={actions.retryResolution}
        testID="arena-retry-resolution"
      >
        Retry resolution
      </Button>
    </View>
  );
}

function TransitionalDecision({
  phase,
}: {
  phase: Extract<ArenaDecisionPhase, { kind: "transitional" }>;
}) {
  return (
    <View style={styles.transitional} testID="arena-decision-transitional">
      {phase.busy ? <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} /> : null}
      <Text style={styles.status}>{phase.label}</Text>
    </View>
  );
}

/**
 * The slot's border, padding, and content column, shared by a battle transition and the
 * preparing state a draft shows before it has a battle to drive it. Both replace the composer,
 * so they have to sit there the same way.
 */
function DecisionBarFrame({
  onLayout,
  testID,
  children,
}: {
  onLayout?: (event: LayoutChangeEvent) => void;
  testID: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // The home indicator's inset sits under the bar's own padding, not in place
  // of it: on a desktop window the inset is zero, and the hint under the vote
  // buttons was touching the window's edge.
  const safeAreaStyle = useMemo(
    () => inlineUnistylesStyle({ paddingBottom: BAR_PADDING + insets.bottom }),
    [insets.bottom],
  );
  return (
    <View style={[styles.bar, safeAreaStyle]} onLayout={onLayout} testID={testID}>
      <ArenaContentColumn>{children}</ArenaContentColumn>
    </View>
  );
}

const STARTING_BATTLE_PHASE: Extract<ArenaDecisionPhase, { kind: "transitional" }> = {
  kind: "transitional",
  label: ARENA_PREPARING_WORKSPACES,
  busy: true,
};

/**
 * Reports the slot's height to the host, once per change.
 *
 * The stream follows its own tail by the height of whatever sits under it, so a bar taking
 * the composer's place has to say how tall it is — otherwise the stream keeps anchoring to
 * the composer that is no longer there.
 */
function useReportedBarHeight(onHeightChange: ((height: number) => void) | undefined) {
  const lastHeightRef = useRef<number | null>(null);
  return useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (lastHeightRef.current === height) return;
      lastHeightRef.current = height;
      onHeightChange?.(height);
    },
    [onHeightChange],
  );
}

/**
 * The slot while a battle is being started, before there is a turn to derive a phase from.
 *
 * Both hosts need it. A draft has no chat yet; a chat that is sending its next battle has one,
 * but its snapshot still describes the turn that finished. Either way the panes are already on
 * screen and there is nothing left to write, so the composer goes now rather than seconds
 * later when the start lands — one move, on the send that caused it.
 */
export function ArenaStartingBattleBar({
  onHeightChange,
}: {
  onHeightChange?: (height: number) => void;
}) {
  const handleLayout = useReportedBarHeight(onHeightChange);
  return (
    <DecisionBarFrame onLayout={handleLayout} testID="arena-starting-battle-bar">
      <View style={styles.row}>
        <TransitionalDecision phase={STARTING_BATTLE_PHASE} />
      </View>
    </DecisionBarFrame>
  );
}

function DecisionContent({
  phase,
  actions,
}: {
  phase: ArenaDecisionPhase;
  actions: ArenaBattleActions;
}) {
  switch (phase.kind) {
    case "running":
    case "awaiting_vote":
    case "awaiting_stop_resolution":
      // The sticky decision pill owns these choices above the composer slot.
      return null;
    case "retry_resolution":
      return <RetryResolutionDecision phase={phase} actions={actions} />;
    case "transitional":
      return <TransitionalDecision phase={phase} />;
  }
}

/** The composer's fallback slot for retries and transitions around a resolution. */
export const ArenaDecisionBar = memo(function ArenaDecisionBar({
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
  const phase = useMemo(() => arenaDecisionPhase(snapshot), [snapshot]);
  const actions = useArenaBattleActions(serverId, agentId, snapshot.turn);
  const lastHeightRef = useRef<number | null>(null);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (lastHeightRef.current === height) return;
      lastHeightRef.current = height;
      onHeightChange(height);
    },
    [onHeightChange],
  );
  const shown = decisionBarShowsPhase(phase);
  useEffect(() => {
    if (shown) return;
    if (lastHeightRef.current === 0) return;
    lastHeightRef.current = 0;
    onHeightChange(0);
  }, [onHeightChange, shown]);
  if (!shown) return null;
  return (
    <DecisionBarFrame onLayout={handleLayout} testID="arena-decision-bar">
      {/* The card's own padding sits inside the column; matching it here puts
          the bar's ends under the panes' edges, one border width short. */}
      <View style={styles.row}>
        <DecisionContent phase={phase} actions={actions} />
      </View>
    </DecisionBarFrame>
  );
});

// theme.spacing[3]; the inline safe-area padding has to add to it, so it is a
// plain number here.
const BAR_PADDING = 12;

const styles = StyleSheet.create((theme) => ({
  bar: {
    width: "100%",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingVertical: BAR_PADDING,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  row: {
    paddingHorizontal: theme.spacing[3],
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sideChoice: {
    minWidth: 96,
    borderRadius: theme.borderRadius.full,
  },
  pillChoice: {
    borderRadius: theme.borderRadius.full,
  },
  sideA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 22),
    borderColor: tint(theme.colors.statusDotRunning, 48),
  },
  sideB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 24),
    borderColor: tint(theme.colors.statusDotWarning, 50),
  },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  transitional: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  error: {
    flex: 1,
    flexShrink: 1,
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  command: {
    fontWeight: theme.fontWeight.semibold,
  },
}));
