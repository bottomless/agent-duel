import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { DesktopWindowControls } from "@/components/desktop/window-controls";
import { DESKTOP_WINDOW_CONTROLS_HEIGHT } from "@/constants/layout";

const containerStyle: ViewStyle = { flex: 1 };
const dragBandStyle: ViewStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: DESKTOP_WINDOW_CONTROLS_HEIGHT,
  pointerEvents: "box-none",
};

/**
 * The account screens replace the app shell, which is where the window controls and drag regions
 * live. On Windows and Linux the window is frameless, so without this a signed-out window has no
 * close, minimize or maximize buttons and cannot be dragged.
 */
export function GateWindowChrome({ children }: { children: ReactNode }) {
  return (
    <View style={containerStyle}>
      {children}
      <View style={dragBandStyle} testID="gate-window-drag-band">
        <TitlebarDragRegion />
      </View>
      <DesktopWindowControls />
    </View>
  );
}
