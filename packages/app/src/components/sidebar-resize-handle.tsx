import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import {
  resolveSidebarResizeHandleGeometry,
  type SidebarResizeEdge,
} from "@/components/sidebar-resize-handle-layout";
import { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { isWeb } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

interface SidebarResizeHandleProps {
  edge: SidebarResizeEdge;
  gesture: GestureType;
  pressed: boolean;
  testID: string;
  width: number;
  onResize: (width: number) => void;
}

const HIGHLIGHT_DELAY_MS = 100;

const webResizeCursorStyle = isWeb
  ? ({
      cursor: "col-resize",
    } as object)
  : null;

function edgeOffsetStyle(edge: SidebarResizeEdge, edgeOffset: number) {
  return edge === "left" ? { left: edgeOffset } : { right: edgeOffset };
}

export function SidebarResizeHandle({
  edge,
  gesture,
  pressed,
  testID,
  width,
  onResize,
}: SidebarResizeHandleProps) {
  const finePointer = useHasFinePointer();

  if (finePointer) {
    return (
      <PointerResizeHandle
        edge={edge}
        gesture={gesture}
        pressed={pressed}
        testID={testID}
        width={width}
        onResize={onResize}
      />
    );
  }
  return (
    <TouchResizeHandle
      edge={edge}
      gesture={gesture}
      pressed={pressed}
      testID={testID}
      width={width}
      onResize={onResize}
    />
  );
}

function PointerResizeHandle({ edge, gesture, testID, width, onResize }: SidebarResizeHandleProps) {
  const [highlighted, setHighlighted] = useState(false);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      onResize(width + direction * (edge === "right" ? 1 : -1) * (event.shiftKey ? 40 : 10));
    },
    [edge, onResize, width],
  );
  const showFocus = useCallback(() => setHighlighted(true), []);
  const hideFocus = useCallback(() => setHighlighted(false), []);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geometry = resolveSidebarResizeHandleGeometry(true);
  const hitAreaStyle = [
    styles.hitArea,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
    webResizeCursorStyle,
  ];

  const cancelHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current === null) return;
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
  }, []);

  const handleHoverIn = useCallback(() => {
    cancelHighlightTimer();
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlighted(true);
    }, HIGHLIGHT_DELAY_MS);
  }, [cancelHighlightTimer]);

  const handleHoverOut = useCallback(() => {
    cancelHighlightTimer();
    setHighlighted(false);
  }, [cancelHighlightTimer]);

  useEffect(() => cancelHighlightTimer, [cancelHighlightTimer]);

  return (
    <GestureDetector gesture={gesture}>
      <Pressable
        testID={testID}
        style={hitAreaStyle}
        accessibilityRole="adjustable"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        {...{ onKeyDown: handleKeyDown }}
        onFocus={showFocus}
        onBlur={hideFocus}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      >
        {highlighted ? (
          <View pointerEvents="none" testID={`${testID}-highlight`} style={styles.highlight} />
        ) : null}
      </Pressable>
    </GestureDetector>
  );
}

function TouchResizeHandle({ edge, gesture, pressed, testID }: SidebarResizeHandleProps) {
  const geometry = resolveSidebarResizeHandleGeometry(false);
  // `box-none` keeps the full-height column out of hit-testing so only the
  // grab target steals taps from the rows behind it.
  const layerStyle = [
    styles.touchLayer,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
  ];
  const targetStyle = [
    styles.touchTarget,
    { width: geometry.width, height: geometry.height ?? undefined },
  ];
  const gripStyle = [
    styles.grip,
    edge === "left" ? styles.leftEdgeGrip : styles.rightEdgeGrip,
    pressed ? styles.visibleGrip : styles.hiddenGrip,
  ];

  return (
    <View pointerEvents="box-none" style={layerStyle}>
      <GestureDetector gesture={gesture}>
        <View
          testID={testID}
          role="separator"
          aria-orientation="vertical"
          collapsable={false}
          style={targetStyle}
        >
          <View pointerEvents="none" testID={`${testID}-grip`} style={gripStyle} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hitArea: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
  },
  highlight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 5,
    width: 1,
    backgroundColor: theme.colors.foreground,
    opacity: 0.25,
  },
  touchLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  touchTarget: {
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    width: 4,
    height: 36,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
  },
  hiddenGrip: {
    opacity: 0,
  },
  visibleGrip: {
    opacity: 0.3,
  },
  leftEdgeGrip: {
    alignSelf: "flex-start",
    marginLeft: theme.spacing[0.5],
  },
  rightEdgeGrip: {
    alignSelf: "flex-end",
    marginRight: theme.spacing[0.5],
  },
}));
