import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import type {
  ArenaHistoryItem,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { ArenaTransitionStatus } from "./transition-status";
import { arenaSetupStatus } from "./transition-progress";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { tint } from "@/styles/tint";
import { createControlGeometry } from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";
import { ArenaContentColumn } from "./content-column";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import { arenaModelDisplayName } from "./side-label";
import {
  arenaDecisionPhase,
  decisionBarShowsPhase,
  type ArenaDecisionPhase,
} from "./decision-state";
import { useArenaBattleActions, type ArenaBattleActions } from "./use-battle-actions";

function sideChoiceLabelKey(kind: "vote" | "keep" | "accept"): string {
  if (kind === "keep") return "arena.keepSide";
  if (kind === "accept") return "arena.acceptSide";
  return "arena.choose";
}

/**
 * The decision for one side: the vote, the early pick, or keeping that side after a stop.
 *
 * Two choices of equal weight, so neither can be the accent. The tint is the side's colour,
 * the blue and amber the diff's column headings use, so the button reads as picking that
 * column. Both sides share a width so the pair reads as one decision. The early pick, offered
 * while the other side still works, shows the tint only on hover (`ArenaRunningPillButton`).
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
  kind: "early" | "vote" | "keep" | "accept";
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();

  const sideLabel = side.toUpperCase();
  if (kind === "early") {
    return (
      <ArenaRunningPillButton
        hoverSide={side}
        label={label ?? t("arena.chooseEarly", { side: sideLabel })}
        loading={loading}
        disabled={disabled}
        onPress={onPress}
        testID={testID}
      />
    );
  }
  const buttonLabel = t(sideChoiceLabelKey(kind), { side: sideLabel });
  return (
    <Button
      variant="secondary"
      size="sm"
      style={[styles.sideChoice, side === "a" ? styles.sideA : styles.sideB]}
      textStyle={[styles.choiceText, styles.sideSolidText]}
      loading={loading}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
    >
      {label ?? buttonLabel}
    </Button>
  );
}

const ThemedCheck = withUnistyles(Check);
const checkColorMapping = {
  a: (theme: Theme) => ({ color: onSideSolid(theme) }),
  b: (theme: Theme) => ({ color: onSideSolid(theme) }),
  middle: (theme: Theme) => ({ color: theme.colors.foreground }),
};

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

/**
 * The vote's choices as one control: the two sides' buttons at its ends and the middle choice, Tie
 * or Discard, a quiet label between them. Separate buttons read Tie as a third answer to pick.
 */
export function ArenaChoiceGroup({ testID, children }: { testID: string; children: ReactNode }) {
  return (
    <View style={styles.choiceGroup} testID={testID}>
      {children}
    </View>
  );
}

/**
 * The choice group with its two sides one width, the wider side's, so the middle choice sits at the
 * group's exact centre whatever the sides say. Tie then stays in one place from the vote to the
 * decision just made, when the sides become the revealed models' names. The group stays invisible
 * for the frame it takes to measure the sides, so the middle never shows off centre.
 */
export function ArenaBalancedChoiceGroup({
  testID,
  children,
}: {
  testID: string;
  /** The start side, the middle choice and the end side, in that order. */
  children: [ReactNode, ReactNode, ReactNode];
}) {
  const [start, middle, end] = children;
  const [startWidth, setStartWidth] = useState<number | null>(null);
  const [endWidth, setEndWidth] = useState<number | null>(null);
  const handleStartLayout = useCallback(
    (event: LayoutChangeEvent) => setStartWidth(event.nativeEvent.layout.width),
    [],
  );
  const handleEndLayout = useCallback(
    (event: LayoutChangeEvent) => setEndWidth(event.nativeEvent.layout.width),
    [],
  );
  const width = startWidth !== null && endWidth !== null ? Math.max(startWidth, endWidth) : null;
  const sideStyle = useMemo(
    () => [styles.balancedSide, inlineUnistylesStyle({ minWidth: width ?? 0 })],
    [width],
  );
  return (
    <View style={[styles.choiceGroup, width === null && styles.measuring]} testID={testID}>
      <View style={sideStyle} onLayout={handleStartLayout}>
        {start}
      </View>
      {middle}
      <View style={sideStyle} onLayout={handleEndLayout}>
        {end}
      </View>
    </View>
  );
}

/** What a decided battle's row offered, and which of its three it took. */
export interface ArenaPastChoice {
  kind: "vote" | "keep";
  chosen: ArenaSide | "middle";
}

/** The row a decided battle's choice was made in, and which button it took. */
export function arenaPastChoice(
  item: Pick<ArenaHistoryItem, "resolution">,
): ArenaPastChoice | null {
  const resolution = item.resolution;
  if (resolution?.kind === "vote") {
    return { kind: "vote", chosen: resolution.vote === "tie" ? "middle" : resolution.vote };
  }
  if (resolution?.kind === "early") return { kind: "vote", chosen: resolution.vote };
  if (resolution?.kind === "stopped") {
    if (resolution.resolution === "apply_a") return { kind: "keep", chosen: "a" };
    if (resolution.resolution === "apply_b") return { kind: "keep", chosen: "b" };
    return { kind: "keep", chosen: "middle" };
  }
  return null;
}

/**
 * A decided battle's choice, drawn as the row it was made in: the same three buttons, the one
 * taken filled in its colour with a check. A side not taken keeps a button's gray fill rather than
 * going blank: a filled half beside an empty one read as a toggle's state, an input still to set,
 * where this is a result. Tie or Discard, a quiet label at the vote, stays one unless taken.
 * Nothing here acts; Show battle is for looking back. With the revealed `identities`, each side's
 * button reads as its model, its logo beside the name, so the choice just made says which model was
 * which.
 */
export function ArenaPastDecision({
  kind,
  chosen,
  identities,
}: ArenaPastChoice & { identities?: ArenaHistoryItem["identities"] }) {
  const { t } = useTranslation();
  const sideLabel = (side: ArenaSide) => {
    const model = identities?.[side].name;
    if (model) return arenaModelDisplayName(model);
    return t(kind === "vote" ? "arena.choose" : "arena.keepSide", { side: side.toUpperCase() });
  };
  const labels = {
    a: sideLabel("a"),
    middle: kind === "vote" ? t("arena.tie") : t("arena.discard"),
    b: sideLabel("b"),
  };
  const item = (choice: ArenaSide | "middle") => {
    const selected = choice === chosen;
    return (
      <View
        accessibilityState={selected ? SELECTED : UNSELECTED}
        style={[
          styles.past,
          choice === "middle" ? styles.pastMiddle : styles.pastSide,
          pastItemStyle(choice, selected),
        ]}
        testID={`arena-past-decision-${choice}${selected ? "-chosen" : ""}`}
      >
        {selected ? <ThemedCheck size={14} uniProps={checkColorMapping[choice]} /> : null}
        {choice !== "middle" && identities ? (
          <ArenaModelVendorIcon
            model={identities[choice].name}
            size={15}
            tone={selected ? "onSolid" : "default"}
          />
        ) : null}
        <Text
          numberOfLines={1}
          style={[styles.choiceText, styles.pastText, pastItemTextStyle(choice, selected)]}
        >
          {labels[choice]}
        </Text>
      </View>
    );
  };
  return (
    <ArenaBalancedChoiceGroup testID="arena-past-decision">
      {item("a")}
      {item("middle")}
      {item("b")}
    </ArenaBalancedChoiceGroup>
  );
}

function pastItemStyle(choice: ArenaSide | "middle", selected: boolean) {
  if (!selected) return choice === "middle" ? styles.pastQuiet : styles.pastNotTaken;
  if (choice === "a") return styles.pastChosenA;
  if (choice === "b") return styles.pastChosenB;
  return styles.pastChosenMiddle;
}

function pastItemTextStyle(choice: ArenaSide | "middle", selected: boolean) {
  if (!selected) return choice === "middle" ? styles.pastQuietText : styles.pastNotTakenText;
  return choice === "middle" ? null : styles.sideSolidText;
}

function runningHoverStyle(side: ArenaSide | null) {
  if (side === "a") return styles.sideTintA;
  if (side === "b") return styles.sideTintB;
  return styles.runningHovered;
}

/**
 * A button in the pill while the battle runs: `Stop` and the early pick share one neutral outline.
 * An uneven pair, one filled or brighter, read as a switch already set to that side (the reply
 * target fills its selected segment with the side's tint), and voters felt pushed to take it
 * before the other side finished. The early pick takes its side's tint only on hover, once the
 * voter reaches for it. Hover is tracked on a plain View (docs/hover.md) and changes colours only.
 */
export function ArenaRunningPillButton({
  hoverSide,
  label,
  loading,
  disabled,
  onPress,
  testID,
  accessibilityLabel,
}: {
  hoverSide: ArenaSide | null;
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
  accessibilityLabel?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Button
        variant="outline"
        size="md"
        textStyle={styles.choiceText}
        style={[
          styles.sideChoice,
          styles.runningChoice,
          hovered && !disabled ? runningHoverStyle(hoverSide) : null,
        ]}
        loading={loading}
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {label}
      </Button>
    </View>
  );
}

export function VoteDecision({
  actions,
  disabled,
}: {
  actions: ArenaBattleActions;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { pending, pendingAction } = actions;
  const tie = useCallback(() => {
    void actions.tie();
  }, [actions]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.pillChoice}
      textStyle={styles.choiceText}
      loading={pendingAction?.kind === "vote" && pendingAction.vote === "tie"}
      disabled={pending || disabled}
      onPress={tie}
      accessibilityLabel={t("arena.tieBattle")}
      accessibilityHint={t("arena.tieHelp")}
      testID="arena-choose-tie"
    >
      {t("arena.tie")}
    </Button>
  );
}

/**
 * The battle's way on after the engine's restart cut it off; continues both agents together. The
 * one filled choice in the pill, so it reads apart from Discard beside it.
 */
export function ResumeDecision({ actions }: { actions: ArenaBattleActions }) {
  const { t } = useTranslation();
  const { pending, pendingAction } = actions;
  const resume = useCallback(() => {
    void actions.resume();
  }, [actions]);
  return (
    <Button
      variant="default"
      size="sm"
      style={styles.pillChoice}
      textStyle={styles.choiceText}
      loading={pendingAction?.kind === "resume_battle"}
      disabled={pending}
      onPress={resume}
      accessibilityLabel={t("arena.resumeBattle")}
      testID="arena-resume-interrupted"
    >
      {t("arena.resume")}{" "}
    </Button>
  );
}

/**
 * The choice to apply neither side: among the choices after a stop or beside Resume after the
 * engine's restart cut the battle off, and at the vote only on the line that says a side failed
 * (`placement="hint"`), as a row action rather than one of the vote's choices.
 */
export function DiscardDecision({
  actions,
  placement = "pill",
}: {
  actions: ArenaBattleActions;
  placement?: "pill" | "hint";
}) {
  const { t } = useTranslation();
  const { pending, pendingAction } = actions;
  const discard = useCallback(() => {
    void actions.resolveStop("discard");
  }, [actions]);
  return (
    <Button
      variant={placement === "pill" ? "ghost" : "outline"}
      size="sm"
      style={placement === "pill" ? styles.pillChoice : undefined}
      textStyle={placement === "pill" ? styles.choiceText : undefined}
      loading={pendingAction?.kind === "resolve_stop" && pendingAction.resolution === "discard"}
      disabled={pending}
      onPress={discard}
      testID="arena-stopped-discard"
    >
      {/* Alone on the failure line it names what it throws away; among the choices its neighbours do. */}
      {placement === "pill" ? t("arena.discard") : t("arena.discardBattle")}
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
  const { t } = useTranslation();
  const { pending, pendingAction } = actions;
  return (
    <View style={styles.retry} testID="arena-resolution-retry-notice">
      <Text style={styles.error}>
        <DetailWithCommands detail={phase.detail} />
      </Text>
      <Button
        variant="outline"
        size="md"
        loading={pendingAction?.kind === "retry_resolution"}
        disabled={pending}
        onPress={actions.retryResolution}
        testID="arena-retry-resolution"
      >
        {t("arena.retryResolution")}{" "}
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
      {phase.busy ? (
        <ArenaTransitionStatus label={phase.label} />
      ) : (
        <Text style={styles.status}>{phase.label}</Text>
      )}
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
  useTranslation();
  const phase = arenaDecisionPhase(snapshot);
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
  const shown = decisionBarShowsPhase(phase) && arenaSetupStatus(snapshot.turn) === null;
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

const CHOICE_HEIGHT = 38;

/**
 * A side's solid fill: its colour mixed toward the text colour, deep on light and pale on dark, with
 * its label in the page colour on top, so the two contrast in both schemes. No branch on
 * `theme.colorScheme`: on web the stylesheet bakes non-colour theme values once, from the first
 * theme, while colours follow the active theme as CSS variables, so a branch here took the light
 * side in dark mode too, and the marks drawn through `uniProps`, which read the live theme, went
 * the other way and disappeared against the fill.
 */
function sideSolid(theme: Theme, color: string): string {
  return `color-mix(in srgb, ${color} 55%, ${theme.colors.foreground})`;
}

/** The label, check and logo on a side's solid fill: the page colour. */
function onSideSolid(theme: Theme): string {
  return theme.colors.surface0;
}

const styles = StyleSheet.create((theme) => ({
  // The buttons' corners plus the group's padding, so the two curves run parallel.
  choiceGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg + theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  // A side's place in a balanced group, its button stretched to the wider side's width and no
  // wider than a long model name needs, which then ends in an ellipsis.
  balancedSide: {
    maxWidth: 240,
  },
  measuring: {
    opacity: 0,
  },
  // The live choices' height, so the pill keeps its size from the vote to the decision just made.
  past: {
    ...createControlGeometry(theme).buttonSm,
    minHeight: CHOICE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 2,
    borderColor: "transparent",
  },
  pastSide: {
    minWidth: 112,
  },
  pastMiddle: {
    minWidth: 72,
  },
  pastQuiet: {
    backgroundColor: "transparent",
  },
  // A side not taken: a plain gray button, so the row reads as a result rather than a toggle.
  pastNotTaken: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.surface3,
  },
  pastNotTakenText: {
    color: theme.colors.foreground,
  },
  pastChosenA: {
    backgroundColor: sideSolid(theme, theme.colors.statusDotRunning),
    borderColor: sideSolid(theme, theme.colors.statusDotRunning),
  },
  pastChosenB: {
    backgroundColor: sideSolid(theme, theme.colors.statusDotWarning),
    borderColor: sideSolid(theme, theme.colors.statusDotWarning),
  },
  pastChosenMiddle: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.foregroundMuted,
  },
  pastText: {
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  pastQuietText: {
    color: theme.colors.foregroundMuted,
  },
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
    fontSize: theme.fontSize.base,
  },
  // The decision's buttons: the landing page's shape, rectangular with semibold labels, between
  // the compact and field heights so the group sits lighter than a field-height row.
  sideChoice: {
    minHeight: CHOICE_HEIGHT,
    minWidth: 112,
    borderRadius: theme.borderRadius.lg,
  },
  pillChoice: {
    minHeight: CHOICE_HEIGHT,
    minWidth: 72,
    borderRadius: theme.borderRadius.lg,
  },
  choiceText: {
    fontWeight: theme.fontWeight.semibold,
  },
  sideA: {
    backgroundColor: sideSolid(theme, theme.colors.statusDotRunning),
    borderColor: sideSolid(theme, theme.colors.statusDotRunning),
  },
  sideB: {
    backgroundColor: sideSolid(theme, theme.colors.statusDotWarning),
    borderColor: sideSolid(theme, theme.colors.statusDotWarning),
  },
  sideSolidText: {
    color: onSideSolid(theme),
  },
  // The early pick's hover: a light wash of its side's colour on the neutral outline.
  sideTintA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 22),
    borderColor: tint(theme.colors.statusDotRunning, 22),
  },
  sideTintB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 24),
    borderColor: tint(theme.colors.statusDotWarning, 24),
  },
  hoverTarget: {
    position: "relative",
  },
  // Opaque: it floats over the end of the answers, which scroll behind it.
  runningChoice: {
    borderColor: tint(theme.colors.foregroundMuted, 35),
    backgroundColor: theme.colors.surface0,
  },
  runningHovered: {
    backgroundColor: theme.colors.surface3,
    borderColor: tint(theme.colors.foregroundMuted, 55),
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
    fontSize: theme.fontSize.base,
  },
  command: {
    fontWeight: theme.fontWeight.semibold,
  },
}));
