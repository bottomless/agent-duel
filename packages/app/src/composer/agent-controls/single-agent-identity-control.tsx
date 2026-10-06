import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EyeOff, ThumbsDown, ThumbsUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useCompactComposerToolbar } from "@/composer/toolbar-layout";
import type { Theme } from "@/styles/theme";

const ThemedThumbsUp = withUnistyles(ThumbsUp);
const ThemedThumbsDown = withUnistyles(ThumbsDown);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

// Desktop menus carry no title, so each option says what it does on its own.
const RATING_OPTIONS: ComboboxOption[] = [
  { id: "up", label: "Rate good and reveal" },
  { id: "down", label: "Rate bad and reveal" },
];
const RATING_HEADER = { title: "Rate to reveal" };

type IdentityStage = "hidden" | "rating" | "revealed";

function identityStage(
  singleAgent: ArenaSnapshot["singleAgent"] | undefined,
  revealRequested: boolean,
): IdentityStage {
  if (!singleAgent || singleAgent.revealed) return "revealed";
  return revealRequested ? "rating" : "hidden";
}

export function SingleAgentIdentityControl({
  disabled,
  pending,
  singleAgent,
  onVote,
}: {
  disabled: boolean;
  pending: boolean;
  singleAgent?: ArenaSnapshot["singleAgent"];
  onVote?: (vote: "up" | "down") => void;
}) {
  const compact = useCompactComposerToolbar();
  const [revealRequested, setRevealRequested] = useState(false);
  useEffect(() => {
    setRevealRequested(false);
  }, [singleAgent?.id, singleAgent?.revealed]);
  const handleReveal = useCallback(() => setRevealRequested(true), []);
  const stage = identityStage(singleAgent, revealRequested);

  // A narrow chat has no room for the sentence or the thumbs: the hidden identity becomes an
  // icon, like the other toolbar controls do, and the rating opens above it the way Thinking's
  // levels do, so the toolbar never reflows mid-reveal.
  if (compact && stage !== "revealed") {
    return <CompactRevealMenu disabled={disabled || pending} onVote={onVote} />;
  }

  return (
    <View style={styles.identity} testID="arena-single-agent-identity">
      {/* One line: a wrapped label grew the toolbar row in a narrow chat. */}
      <Text style={styles.identityLabel} numberOfLines={1}>
        {singleAgent?.identity?.name ?? "Agent identity hidden"}
      </Text>
      {stage === "hidden" ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Reveal agent identity"
          disabled={disabled}
          onPress={handleReveal}
          testID="arena-single-agent-reveal"
        >
          <Text style={styles.reveal}>reveal</Text>
        </Pressable>
      ) : null}
      {stage === "rating" ? <RevealRating disabled={disabled || pending} onVote={onVote} /> : null}
    </View>
  );
}

function CompactRevealMenu({
  disabled,
  onVote,
}: {
  disabled: boolean;
  onVote?: (vote: "up" | "down") => void;
}) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const handlePress = useCallback(() => setOpen((value) => !value), []);
  const handleSelect = useCallback(
    (id: string) => onVote?.(id === "down" ? "down" : "up"),
    [onVote],
  );
  const renderOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean; onPress: () => void }) => (
      <RatingOptionItem option={args.option} active={args.active} onPress={args.onPress} />
    ),
    [],
  );
  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={EyeOff}
            surface="toolbar"
            label="Agent identity hidden"
            showToolbarLabel={false}
            open={open}
            disabled={disabled}
            onPress={handlePress}
            accessibilityLabel="Reveal agent identity"
            testID="arena-single-agent-reveal"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>Agent identity hidden · rate to reveal</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={RATING_OPTIONS}
        value=""
        onSelect={handleSelect}
        renderOption={renderOption}
        header={RATING_HEADER}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={180}
      />
    </>
  );
}

function RatingOptionItem({
  option,
  active,
  onPress,
}: {
  option: ComboboxOption;
  active: boolean;
  onPress: () => void;
}) {
  const leadingSlot = useMemo(
    () =>
      option.id === "down" ? (
        <ThemedThumbsDown size={16} uniProps={foregroundMapping} />
      ) : (
        <ThemedThumbsUp size={16} uniProps={foregroundMapping} />
      ),
    [option.id],
  );
  return (
    <ComboboxItem
      label={option.label}
      active={active}
      onPress={onPress}
      accessibilityLabel={`${option.label} agent identity`}
      leadingSlot={leadingSlot}
      testID={`arena-single-agent-rate-${option.id}`}
    />
  );
}

function RevealRating({
  disabled,
  onVote,
}: {
  disabled: boolean;
  onVote?: (vote: "up" | "down") => void;
}) {
  const handleThumbsUp = useCallback(() => onVote?.("up"), [onVote]);
  const handleThumbsDown = useCallback(() => onVote?.("down"), [onVote]);
  return (
    <View style={styles.rating}>
      <Text style={styles.ratingLabel}>Rate to reveal</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Thumbs up and reveal agent identity"
        disabled={disabled}
        onPress={handleThumbsUp}
        style={styles.ratingButton}
        testID="arena-single-agent-thumbs-up"
      >
        <ThemedThumbsUp size={14} uniProps={foregroundMapping} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Thumbs down and reveal agent identity"
        disabled={disabled}
        onPress={handleThumbsDown}
        style={styles.ratingButton}
        testID="arena-single-agent-thumbs-down"
      >
        <ThemedThumbsDown size={14} uniProps={foregroundMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  identity: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  identityLabel: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  reveal: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "underline",
  },
  rating: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  ratingLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  ratingButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
}));
