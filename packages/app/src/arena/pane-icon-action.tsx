import type { ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MenuTriggerState } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An icon-only action in a contestant pane's header: the workspace header's icon-action
 * shape (8px around the glyph) at the xs height, no border, and the kebab trigger's hover
 * surface. The worktree menu's trigger takes the same styles so the pair reads as one.
 */
function paneIconActionStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.action, (hovered || pressed) && styles.actionActive];
}

export function paneIconMenuTriggerStyle({ hovered, open }: MenuTriggerState) {
  return [styles.action, (hovered || open) && styles.actionActive];
}

export function PaneIconAction({
  accessibilityLabel,
  onPress,
  testID,
  children,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  testID: string;
  children: ReactNode;
}) {
  // An icon alone does not say what it does, so the label shows on hover too. The trigger is
  // the button itself, as the message copy button does, so hover and press stay on one element.
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={paneIconActionStyle}
        testID={testID}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{accessibilityLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    // Keyboard focus lands here after Back to comparison, so the ring has to be visible.
    _web: {
      outlineStyle: "none",
      "_focus-visible": {
        outlineStyle: "solid",
        outlineWidth: 2,
        outlineColor: theme.colors.foreground,
        outlineOffset: -2,
      },
    },
  },
  actionActive: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
