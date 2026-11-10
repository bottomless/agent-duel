import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";

export interface ArenaSwitchOption<T extends string> {
  value: T;
  label: string;
  testID: string;
}

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
  testID,
}: {
  options: readonly ArenaSwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Tabs switch what the region shows; a radio group sets how it is shown. */
  role: "tablist" | "radiogroup";
  size?: "sm" | "xs";
  testID: string;
}) {
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
}: {
  option: ArenaSwitchOption<T>;
  selected: boolean;
  onSelect: (value: T) => void;
  role: "tab" | "radio";
  size: "sm" | "xs";
}) {
  const handlePress = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  const accessibilityState = useMemo(
    () => (role === "tab" ? { selected } : { checked: selected }),
    [role, selected],
  );
  const segmentStyle = useMemo(() => pressStyle(selected, size), [selected, size]);
  return (
    <PressHighlight
      accessibilityRole={role}
      accessibilityState={accessibilityState}
      aria-selected={role === "tab" ? selected : undefined}
      onPress={handlePress}
      style={segmentStyle}
      testID={option.testID}
    >
      <Text style={[styles.text, size === "xs" && styles.textXs, selected && styles.textSelected]}>
        {option.label}
      </Text>
    </PressHighlight>
  );
}

function pressStyle(selected: boolean, size: "sm" | "xs") {
  return ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
    styles.segment,
    size === "xs" && styles.segmentXs,
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
  segment: {
    justifyContent: "center",
    minHeight: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
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
