import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";

export interface ArenaSwitchOption<T extends string> {
  value: T;
  label: string;
  /** A number shown as a badge after the label, such as the files a tab lists. */
  count?: number;
  testID: string;
}

// A segment's horizontal padding and border, around its measured content.
const SEGMENT_PADDING = 12;
const SEGMENT_BORDER = 1;

/**
 * The review's small segmented switch: a tinted track, the selected segment raised on the
 * surface with a faint edge. Medium weight, not semibold, so it reads as a control without
 * competing with the vote. The review's Difference summary | Changes and the diff layout's Side by side | One
 * column share it, so the two controls in one row read as the same kind of thing.
 */
export function ArenaSegmentedSwitch<T extends string>({
  options,
  value,
  onChange,
  role,
  size = "sm",
  equalWidths = false,
  testID,
}: {
  options: readonly ArenaSwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Tabs switch what the region shows; a radio group sets how it is shown. */
  role: "tablist" | "radiogroup";
  size?: "sm" | "xs";
  /**
   * Every segment as wide as the widest, so a centred switch puts the seam between two segments on
   * the centre line, over the vote's Tie, instead of leaning toward the longer label.
   */
  equalWidths?: boolean;
  testID: string;
}) {
  const [contentWidths, setContentWidths] = useState<Record<string, number>>({});
  const onContentWidth = useCallback((key: string, width: number) => {
    setContentWidths((current) =>
      Math.abs((current[key] ?? 0) - width) < 0.5 ? current : { ...current, [key]: width },
    );
  }, []);
  const widest = Math.max(0, ...options.map((option) => contentWidths[option.value] ?? 0));
  const segmentWidth =
    equalWidths && widest > 0 ? widest + 2 * (SEGMENT_PADDING + SEGMENT_BORDER) : undefined;
  return (
    <View style={styles.track} accessibilityRole={role} testID={testID}>
      {options.map((option) => (
        <Segment
          key={option.value}
          option={option}
          selected={option.value === value}
          onSelect={onChange}
          role={role === "tablist" ? "tab" : "radio"}
          size={size}
          minWidth={segmentWidth}
          onContentWidth={equalWidths ? onContentWidth : undefined}
        />
      ))}
    </View>
  );
}

function Segment<T extends string>({
  option,
  selected,
  onSelect,
  role,
  size,
  minWidth,
  onContentWidth,
}: {
  option: ArenaSwitchOption<T>;
  selected: boolean;
  onSelect: (value: T) => void;
  role: "tab" | "radio";
  size: "sm" | "xs";
  minWidth?: number;
  onContentWidth?: (key: string, width: number) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  const accessibilityState = useMemo(
    () => (role === "tab" ? { selected } : { checked: selected }),
    [role, selected],
  );
  const segmentStyle = useMemo(
    () => pressStyle(selected, size, minWidth),
    [selected, size, minWidth],
  );
  // The content keeps its natural width inside a widened segment, so it can be measured again.
  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => onContentWidth?.(option.value, event.nativeEvent.layout.width),
    [onContentWidth, option.value],
  );
  return (
    <PressHighlight
      accessibilityRole={role}
      accessibilityState={accessibilityState}
      aria-selected={role === "tab" ? selected : undefined}
      onPress={handlePress}
      style={segmentStyle}
      testID={option.testID}
    >
      <View style={styles.content} onLayout={onContentWidth ? handleContentLayout : undefined}>
        <View>
          <Text
            style={[styles.text, size === "xs" && styles.textXs, selected && styles.textSelected]}
          >
            {option.label}
          </Text>
          {/* The selected weight is wider; reserving it keeps the switch still when it changes. */}
          <Text
            aria-hidden
            style={[
              styles.text,
              size === "xs" && styles.textXs,
              styles.textSelected,
              styles.reserve,
            ]}
          >
            {option.label}
          </Text>
        </View>
        {option.count !== undefined ? <StatusBadge label={String(option.count)} size="xs" /> : null}
      </View>
    </PressHighlight>
  );
}

function pressStyle(selected: boolean, size: "sm" | "xs", minWidth: number | undefined) {
  const width = minWidth === undefined ? null : { minWidth };
  return ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
    styles.segment,
    size === "xs" && styles.segmentXs,
    width,
    selected && styles.selected,
    !selected && (hovered || pressed) && styles.hovered,
  ];
}

const styles = StyleSheet.create((theme) => ({
  track: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    padding: 2,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  // 36px segments make a 40px switch, closer to the vote's 48px group below the review.
  segment: {
    justifyContent: "center",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: SEGMENT_PADDING,
    borderRadius: theme.borderRadius.base,
    borderWidth: SEGMENT_BORDER,
    borderColor: "transparent",
  },
  segmentXs: {
    minHeight: 24,
    paddingHorizontal: theme.spacing[2],
  },
  selected: {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.borderAccent,
  },
  hovered: {
    opacity: 0.8,
  },
  reserve: {
    height: 0,
    overflow: "hidden",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: Math.round((theme.fontSize.base * 13) / 14),
  },
  textXs: {
    fontSize: theme.fontSize.sm,
  },
  textSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
}));
