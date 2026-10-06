import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";
import { applySidePanelPlacement } from "./side-panel-placement";

function splitLayout(direction: "horizontal" | "vertical"): WorkspaceLayout {
  return {
    root: {
      kind: "group",
      group: {
        id: "group_1",
        direction,
        children: [
          { kind: "pane", pane: { id: "pane_main", tabIds: [], focusedTabId: null } },
          { kind: "pane", pane: { id: "pane_side", tabIds: [], focusedTabId: null } },
        ],
        sizes: [0.7, 0.3],
      },
    },
    focusedPaneId: "pane_main",
  };
}

const bareLayout: WorkspaceLayout = {
  root: { kind: "pane", pane: { id: "pane_main", tabIds: [], focusedTabId: null } },
  focusedPaneId: "pane_main",
};

describe("applySidePanelPlacement", () => {
  it("lays the workspace out along the axis the placement names", () => {
    expect(applySidePanelPlacement(splitLayout("horizontal"), "bottom").root).toMatchObject({
      group: { direction: "vertical" },
    });
    expect(applySidePanelPlacement(splitLayout("vertical"), "right").root).toMatchObject({
      group: { direction: "horizontal" },
    });
  });

  it("keeps the panes, their order and the split", () => {
    const moved = applySidePanelPlacement(splitLayout("horizontal"), "bottom");
    const group = moved.root.kind === "group" ? moved.root.group : null;

    // Moving the panel is a change of axis, not of content: the same panes in the same order,
    // still holding the split the reader dragged.
    expect(group?.children.map((child) => (child.kind === "pane" ? child.pane.id : null))).toEqual([
      "pane_main",
      "pane_side",
    ]);
    expect(group?.sizes).toEqual([0.7, 0.3]);
    expect(moved.focusedPaneId).toBe("pane_main");
  });

  it("hands back the same layout when there is nothing to move", () => {
    const alreadyRight = splitLayout("horizontal");
    // Referential equality keeps the memoized split container from re-rendering for nothing.
    expect(applySidePanelPlacement(alreadyRight, "right")).toBe(alreadyRight);
    expect(applySidePanelPlacement(bareLayout, "bottom")).toBe(bareLayout);
  });
});
