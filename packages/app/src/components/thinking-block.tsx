import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { Brain } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { thinkingMarkdownParser } from "@/components/markdown/thinking-parser";
import { ExpandableBadge } from "@/components/message";

interface ThinkingBlockProps {
  text: string;
  active?: boolean;
  compact?: boolean;
  defaultExpanded?: boolean;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
}

export function ThinkingBlock({
  text,
  active = false,
  compact = false,
  defaultExpanded = false,
  isLastInSequence = false,
  disableOuterSpacing,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const handleToggle = useCallback(() => setIsExpanded((expanded) => !expanded), []);
  const renderDetails = useCallback(
    () => (
      <View style={styles.content}>
        <MarkdownRenderer
          text={text}
          compact={compact}
          subdued
          markdownit={thinkingMarkdownParser}
          enableHtmlish={false}
          enableDiagrams={false}
          horizontalScrollCodeBlocks
        />
      </View>
    ),
    [compact, text],
  );

  return (
    <ExpandableBadge
      testID="thinking-block"
      label="Thinking"
      icon={Brain}
      style={isExpanded ? styles.rail : undefined}
      isExpanded={isExpanded}
      onToggle={handleToggle}
      renderDetails={renderDetails}
      isLoading={active}
      isLastInSequence={isLastInSequence}
      disableOuterSpacing={disableOuterSpacing}
      borderlessWhenExpanded
      transparentWhenExpanded
      compactLabel={compact}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    borderLeftWidth: theme.borderWidth[2],
    borderColor: theme.colors.border,
    paddingLeft: theme.spacing[1],
  },
  content: {
    minWidth: 0,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
}));
