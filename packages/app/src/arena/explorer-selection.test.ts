import { beforeEach, describe, expect, it, vi } from "vitest";

const openWorkspaceSidePanelTab = vi.fn();
vi.mock("@/workspace/side-panel-command", () => ({
  openWorkspaceSidePanelTab: (input: unknown) => openWorkspaceSidePanelTab(input),
}));

const { openArenaWorktreeChanges, useArenaExplorerSelectionStore } =
  await import("./explorer-selection");

describe("openArenaWorktreeChanges", () => {
  beforeEach(() => {
    openWorkspaceSidePanelTab.mockClear();
    useArenaExplorerSelectionStore.setState({ sideByWorkspace: {} });
  });

  it("aims the picker at the run and opens the Changes tab", () => {
    openArenaWorktreeChanges({ serverId: "srv", workspaceId: "wks", side: "b" });

    expect(useArenaExplorerSelectionStore.getState().sideByWorkspace).toEqual({ "srv:wks": "b" });
    expect(openWorkspaceSidePanelTab).toHaveBeenCalledWith({
      serverId: "srv",
      workspaceId: "wks",
      target: { kind: "changes" },
    });
  });

  it("does nothing without a workspace to open it in", () => {
    openArenaWorktreeChanges({ serverId: "srv", workspaceId: null, side: "a" });
    openArenaWorktreeChanges({ serverId: "srv", workspaceId: "  ", side: "a" });

    expect(useArenaExplorerSelectionStore.getState().sideByWorkspace).toEqual({});
    expect(openWorkspaceSidePanelTab).not.toHaveBeenCalled();
  });

  it("keeps one selection per workspace", () => {
    openArenaWorktreeChanges({ serverId: "srv", workspaceId: "wks", side: "a" });
    openArenaWorktreeChanges({ serverId: "srv", workspaceId: "other", side: "b" });
    useArenaExplorerSelectionStore.getState().select("srv:wks", null);

    expect(useArenaExplorerSelectionStore.getState().sideByWorkspace).toEqual({
      "srv:wks": null,
      "srv:other": "b",
    });
  });
});
