import type { ReactNode } from "react";
import { Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

interface SettingsSelectTriggerProps {
  label: string;
  accessibilityLabel: string;
  /** Drawn before the label, such as a theme's swatch. */
  children?: ReactNode;
  disabled?: boolean;
  testID?: string;
}

/**
 * The trigger of a settings row's dropdown: the selected value and a chevron in a bordered pill.
 * Every settings dropdown uses it, so they read as one control. Goes inside a `<DropdownMenu>`.
 */
export function SettingsSelectTrigger({
  label,
  accessibilityLabel,
  children,
  disabled,
  testID,
}: SettingsSelectTriggerProps) {
  return (
    <DropdownMenuTrigger
      style={triggerStyle}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      testID={testID}
    >
      {children}
      <Text style={styles.triggerText}>{label}</Text>
      <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </DropdownMenuTrigger>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
