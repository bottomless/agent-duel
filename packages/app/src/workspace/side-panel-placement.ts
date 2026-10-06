import type { SidePanelPlacement } from "@/hooks/use-settings";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";

export type { SidePanelPlacement };

export const SIDE_PANEL_PLACEMENTS: readonly SidePanelPlacement[] = ["right", "bottom"];

/**
 * Where the panel sits is how the workspace is laid out, not what it holds, so it is one app
 * preference rather than something stored per workspace. The layout tree stays as it is —
 * main pane first, side pane second — and only the axis it is laid out along changes, which is
 * why moving the panel keeps every tab, its focus and the split it was dragged to.
 */
export function applySidePanelPlacement(
  layout: WorkspaceLayout,
  placement: SidePanelPlacement,
): WorkspaceLayout {
  const root = layout.root;
  if (root.kind !== "group") {
    return layout;
  }
  const direction = placement === "bottom" ? "vertical" : "horizontal";
  if (root.group.direction === direction) {
    return layout;
  }
  return {
    ...layout,
    root: { ...root, group: { ...root.group, direction } },
  };
}
