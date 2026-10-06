import { type Ref } from "react";
import { useDroppable } from "@dnd-kit/core";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface SplitDropZoneHover {
  paneId: string;
}

export interface SplitDropZoneProps {
  paneId: string;
  active: boolean;
  preview: SplitDropZoneHover | null;
}

export function buildSplitDropZoneId(paneId: string): string {
  return `split-pane-drop:${paneId}`;
}

/**
 * Whole-pane drop target shown while a tab is dragged: dropping a tab on a pane
 * moves it there. The layout is main pane plus side pane, so there is nothing to
 * split; the tab strip handles ordering within a pane.
 */
export function SplitDropZone({ paneId, active, preview }: SplitDropZoneProps) {
  const { setNodeRef } = useDroppable({
    id: buildSplitDropZoneId(paneId),
    disabled: !active,
    data: {
      kind: "split-pane-drop",
      paneId,
    },
  });

  if (!active) {
    return null;
  }

  return (
    <View ref={setNodeRef as unknown as Ref<View>} style={styles.overlay} pointerEvents="none">
      {preview?.paneId === paneId ? (
        <>
          <View pointerEvents="none" style={styles.previewOverlay} />
          <View pointerEvents="none" style={styles.previewFrame} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
  },
  previewOverlay: {
    position: "absolute",
    left: theme.spacing[2],
    top: theme.spacing[2],
    right: theme.spacing[2],
    bottom: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
    opacity: 0.6,
  },
  previewFrame: {
    position: "absolute",
    left: theme.spacing[2],
    top: theme.spacing[2],
    right: theme.spacing[2],
    bottom: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 2,
    borderColor: theme.colors.accent,
  },
}));
