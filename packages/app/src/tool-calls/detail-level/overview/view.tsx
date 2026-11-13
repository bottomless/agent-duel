import React, { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { IndentRail } from "@/components/indent-rail";
import { EXPANDABLE_BADGE_DETAIL_INSET, ExpandableBadge } from "@/components/message";
import { useIsCompactFormFactor } from "@/constants/layout";
import { arenaChatWorkLabel } from "@/arena/chat-work";
import { useOverviewSummaryLabel } from "./label";
import type { OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupSheet } from "./sheet";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
  /** A battle chat's row: the battle pane's words, flush with the prose around it. */
  arena?: boolean;
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
  arena = false,
}: OverviewGroupProps) {
  const scrollRef = useRef<ScrollView>(null);
  const isCompact = useIsCompactFormFactor();
  const overviewSummary = useOverviewSummaryLabel(group.summary);
  const aggregateSummary = useMemo(
    () => (arena ? arenaChatWorkLabel(group.run, group.isLoading) : overviewSummary),
    [arena, group.isLoading, group.run, overviewSummary],
  );
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const hold = useDisclosureHold();
  const toggle = useCallback(() => {
    const apply = () => onExpandedChange(group.run.id, !expanded);
    // Compact opens a sheet; nothing in the timeline moves.
    if (isCompact) apply();
    else hold(apply);
  }, [expanded, group.run.id, hold, isCompact, onExpandedChange]);
  const close = useCallback(() => {
    onExpandedChange(group.run.id, false);
  }, [group.run.id, onExpandedChange]);
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        <IndentRail>{children}</IndentRail>
      </ScrollView>
    ),
    [children, scrollToLatest],
  );

  if (isCompact) {
    return (
      <>
        <ExpandableBadge
          testID="tool-call-group"
          label={aggregateSummary}
          icon={Wrench}
          isLoading={group.isLoading}
          isExpanded={false}
          isLastInSequence={isLastInSequence}
          onToggle={toggle}
          flushRow={arena}
          labelSizedIcon={arena}
        />
        <OverviewToolCallGroupSheet visible={expanded} summary={aggregateSummary} onClose={close}>
          {children}
        </OverviewToolCallGroupSheet>
      </>
    );
  }

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={aggregateSummary}
      icon={Wrench}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
      flushRow={arena}
      labelSizedIcon={arena}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: EXPANDABLE_BADGE_DETAIL_INSET,
  },
}));
