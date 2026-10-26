import { memo, useCallback } from "react";
import { View } from "react-native";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { EXPANDABLE_BADGE_DETAIL_INSET, ExpandableBadge } from "@/components/message";

/**
 * Reasoning no tool call followed, in a battle chat, read as the battle pane reads it: a work row
 * named for what it was, flush with the prose, that opens the reasoning on request.
 */
export const ArenaChatReasoning = memo(function ArenaChatReasoning({
  itemId,
  text,
  active,
  expanded,
  onExpandedChange,
}: {
  itemId: string;
  text: string;
  active: boolean;
  expanded: boolean;
  onExpandedChange: (itemId: string, expanded: boolean) => void;
}) {
  const toggle = useCallback(
    () => onExpandedChange(itemId, !expanded),
    [expanded, itemId, onExpandedChange],
  );
  const renderDetails = useCallback(
    () => (
      <View style={styles.details}>
        <MarkdownRenderer text={text} subdued />
      </View>
    ),
    [text],
  );
  return (
    <ExpandableBadge
      testID="arena-chat-reasoning"
      label={active ? "Reasoning…" : "Reasoned"}
      icon={Wrench}
      isLoading={active}
      isExpanded={expanded}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
      flushRow
      labelSizedIcon
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  details: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: EXPANDABLE_BADGE_DETAIL_INSET,
  },
}));
