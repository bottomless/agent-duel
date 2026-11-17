import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { View, type ViewStyle } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { DesktopWindowControls } from "@/components/desktop/window-controls";
import { DESKTOP_WINDOW_CONTROLS_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";

const containerStyle: ViewStyle = { flex: 1 };
const chromeStyle: ViewStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: DESKTOP_WINDOW_CONTROLS_HEIGHT,
  zIndex: OVERLAY_Z.windowChrome,
  // The overlay root passes `pointer-events: none` down; the whole band is a drag region anyway.
  pointerEvents: "auto",
};

/**
 * The account screens replace the app shell, which is where the window controls and drag regions
 * live. On Windows and Linux the window is frameless, so without this a signed-out window has no
 * close, minimize or maximize buttons and cannot be dragged.
 *
 * The band goes to the overlay root above modals: the terms prompt is a modal whose backdrop would
 * otherwise cover the controls.
 */
export function GateWindowChrome({ children }: { children: ReactNode }) {
  const chrome = (
    <View style={chromeStyle} testID="gate-window-chrome">
      <TitlebarDragRegion />
      <DesktopWindowControls />
    </View>
  );
  return (
    <View style={containerStyle}>
      {children}
      {isWeb && typeof document !== "undefined" ? createPortal(chrome, getOverlayRoot()) : chrome}
    </View>
  );
}
