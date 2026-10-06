import type { SplitNode, SplitPane } from "@/stores/workspace-layout-store";

/**
 * Which part of the layout tree to render. Focus mode shows only the focused
 * pane; a hidden side panel drops its pane from the render while the layout
 * keeps it, so its tabs come back when the panel is shown again. Compact widths
 * never show both panes: the side pane takes the whole width while the panel
 * is open, and the chat has it otherwise.
 */
export function resolveSplitContainerRoot(input: {
  root: SplitNode;
  focusedPaneId: string | null;
  focusModeEnabled: boolean | undefined;
  sidePaneId?: string | null;
  sidePanelOpen?: boolean;
  compact?: boolean;
}): { root: SplitNode; usesFallbackStrip: boolean } {
  if (input.focusModeEnabled) {
    const focusedPane = input.focusedPaneId ? findPane(input.root, input.focusedPaneId) : null;
    if (!focusedPane) return { root: input.root, usesFallbackStrip: true };
    return { root: { kind: "pane", pane: focusedPane }, usesFallbackStrip: false };
  }
  if (input.compact && input.sidePanelOpen && input.sidePaneId) {
    const sidePane = findPane(input.root, input.sidePaneId);
    if (sidePane) return { root: { kind: "pane", pane: sidePane }, usesFallbackStrip: false };
  }
  if (
    (input.compact || input.sidePanelOpen === false) &&
    input.sidePaneId &&
    input.root.kind === "group"
  ) {
    const mainChild = input.root.group.children.find(
      (child) => !(child.kind === "pane" && child.pane.id === input.sidePaneId),
    );
    if (mainChild) return { root: mainChild, usesFallbackStrip: false };
  }
  return { root: input.root, usesFallbackStrip: false };
}

function findPane(node: SplitNode, paneId: string): SplitPane | null {
  if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.group.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}
