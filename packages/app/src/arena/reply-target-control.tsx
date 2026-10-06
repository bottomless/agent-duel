import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { ArenaReplyTarget } from "@getpaseo/protocol/arena/rpc-schemas";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useCompactComposerToolbar } from "@/composer/toolbar-layout";
import type { MessagePayload } from "@/composer/types";
import { tint } from "@/styles/tint";
import { reconcileArenaReplySelection, type ArenaReplyAction } from "./reply-state";
import { useArenaReplyTargetStore } from "./reply-target-store";

const TARGETS: readonly ArenaReplyTarget[] = ["both", "a", "b"];

/** "Agent A" where there is room for it; the letter alone on a compact composer. */
function targetLabel(target: ArenaReplyTarget, compact: boolean): string {
  if (target === "both") return "Both";
  const letter = target.toUpperCase();
  return compact ? letter : `Agent ${letter}`;
}

function unavailableLabel(target: ArenaReplyTarget): string {
  if (target === "both") return "Both contestants cannot take the same message right now";
  return `Agent ${target.toUpperCase()} cannot take a message right now`;
}

/**
 * Who a follow-up goes to: Both, A, or B, at the composer's leading edge where the eye lands
 * before typing. Both is the default and the common case; A and B take their side's tint, the
 * colour of that pane's Choose button, so the target reads against the columns above. A side
 * that cannot take a message right now is a disabled segment rather than a missing one.
 */
export function ArenaReplyTargetControl({
  actions,
  value,
  onValueChange,
}: {
  actions: readonly ArenaReplyAction[];
  value: ArenaReplyTarget | null;
  onValueChange: (target: ArenaReplyTarget) => void;
}) {
  const compact = useCompactComposerToolbar();
  const options = useMemo<SegmentedControlOption<ArenaReplyTarget>[]>(
    () =>
      TARGETS.map((target) => {
        const action = actions.find((candidate) => candidate.target === target);
        let selectedStyle;
        if (target === "a") selectedStyle = styles.selectedA;
        else if (target === "b") selectedStyle = styles.selectedB;
        return {
          value: target,
          label: targetLabel(target, compact),
          accessibilityLabel: action ? action.label : unavailableLabel(target),
          disabled: !action,
          selectedStyle,
          selectedLabelStyle: target === "both" ? undefined : styles.selectedSideLabel,
          testID: `arena-reply-target-${target}`,
        };
      }),
    [actions, compact],
  );
  return (
    <SegmentedControl
      options={options}
      value={value}
      onValueChange={onValueChange}
      size="xs"
      style={styles.track}
      testID="arena-reply-target-control"
    />
  );
}

export function useArenaReplyComposerControls({
  enabled,
  turnId,
  actions,
  onSubmit,
}: {
  enabled: boolean;
  turnId: string | null;
  actions: readonly ArenaReplyAction[];
  onSubmit: (target: ArenaReplyTarget, payload: MessagePayload) => Promise<void>;
}): {
  leftContent: ReactNode;
  submit: (payload: MessagePayload) => Promise<void>;
  selectedAction: ArenaReplyAction | undefined;
} {
  const storedSelection = useArenaReplyTargetStore((state) =>
    turnId ? (state.selections[turnId] ?? null) : null,
  );
  const reconcile = useArenaReplyTargetStore((state) => state.reconcile);
  const select = useArenaReplyTargetStore((state) => state.select);
  useEffect(() => {
    reconcile(turnId, actions);
  }, [actions, reconcile, turnId]);
  const selection = reconcileArenaReplySelection(storedSelection, turnId, actions);
  const selectedTarget = selection?.target ?? null;
  const handleTargetChange = useCallback(
    (target: ArenaReplyTarget) => {
      if (turnId) select(turnId, target);
    },
    [select, turnId],
  );
  const submit = useCallback(
    async (payload: MessagePayload) => {
      if (!selectedTarget) throw new Error("Choose a contestant before sending.");
      await onSubmit(selectedTarget, payload);
    },
    [onSubmit, selectedTarget],
  );
  const leftContent = useMemo(() => {
    if (!enabled) return undefined;
    return (
      <ArenaReplyTargetControl
        actions={actions}
        value={selectedTarget}
        onValueChange={handleTargetChange}
      />
    );
  }, [actions, enabled, handleTargetChange, selectedTarget]);

  return {
    leftContent,
    submit,
    selectedAction: actions.find((action) => action.target === selectedTarget),
  };
}

const styles = StyleSheet.create((theme) => ({
  // A track under the three segments: on its own the control's bare labels read as three
  // words in the toolbar rather than one choice.
  track: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    padding: 2,
    gap: 0,
  },
  // The same tints as Choose A and Choose B, so the target and the vote agree on colour.
  selectedA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 22),
  },
  selectedB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 24),
  },
  selectedSideLabel: {
    color: theme.colors.foreground,
  },
}));
