import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WindowChromeRootRegion } from "@/utils/desktop-window";

interface DesktopPanelOverlayProps {
  children: ReactNode;
  edge: "left" | "right";
  onDismiss: () => void;
  open: boolean;
  testID: string;
}

/**
 * Floats a desktop panel over the center instead of beside it, for the widths
 * where pinning it would squeeze the center below its minimum.
 *
 * The panel stays mounted while closed — the agent list retains its list state
 * and subscriptions across a toggle — so only the backdrop is conditional, and
 * the panel hides itself the same way it does when pinned and closed. There is
 * no slide: pinned panels appear and disappear instantly, and a drawer that
 * animates only on the way in reads as a stutter next to them.
 */
export function DesktopPanelOverlay({
  children,
  edge,
  onDismiss,
  open,
  testID,
}: DesktopPanelOverlayProps) {
  return (
    <View pointerEvents="box-none" style={styles.overlay} testID={testID}>
      {open ? (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={onDismiss}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
      ) : null}
      <View
        pointerEvents={open ? "auto" : "none"}
        style={edge === "left" ? styles.leftPanel : styles.rightPanel}
      >
        <WindowChromeRootRegion corners={edge === "left" ? "top-left" : "top-right"}>
          {children}
        </WindowChromeRootRegion>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  // A row so the panel, which sizes itself horizontally, stretches to the full
  // height of the overlay instead of ending where its content does.
  leftPanel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    flexDirection: "row",
    maxWidth: "100%",
    ...theme.shadow.lg,
  },
  rightPanel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: "row",
    maxWidth: "100%",
    ...theme.shadow.lg,
  },
}));
