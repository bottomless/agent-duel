import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import {
  findPaneContainingTab,
  getWorkspaceMainPane,
  getWorkspaceSidePane,
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const WORKSPACE_KEY = "server-1:workspace-1";
const PARENT_TAB_ID = "agent_parent";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    layoutByWorkspace: {},
    sidePanelOpenByWorkspace: {},
  });
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "parent" },
    intent: "reveal",
  });
});

function openPreferred(target: WorkspaceTabTarget, subagents = false): string | null {
  return openPreferredWorkspaceTarget({
    workspaceKey: WORKSPACE_KEY,
    target,
    source: "subagents",
    preferences: { ...DEFAULT_APP_SETTINGS.openInSidePane, subagents },
    parentTabId: PARENT_TAB_ID,
  });
}

function layout() {
  return useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
}

function paneIdHolding(tabId: string | null): string | undefined {
  return findPaneContainingTab(layout().root, tabId ?? "")?.id;
}

describe("openPreferredWorkspaceTarget", () => {
  it.each([false, true])(
    "opens a supporting view in the side panel whatever the side preference (%s)",
    (subagents) => {
      const tabId = openPreferred(
        { kind: "provider_subagent", parentAgentId: "parent", subagentId: "task-1" },
        subagents,
      );

      const sidePane = getWorkspaceSidePane(layout().root);
      expect(sidePane).not.toBeNull();
      expect(paneIdHolding(tabId)).toBe(sidePane!.id);
      expect(layout().focusedPaneId).toBe(sidePane!.id);
      expect(layout().parentTabIdByTabId?.[tabId!]).toBe(PARENT_TAB_ID);
    },
  );

  it("opens a chat in the main pane even when the side preference is on", () => {
    const tabId = openPreferred({ kind: "agent", agentId: "child" }, true);

    expect(paneIdHolding(tabId)).toBe(getWorkspaceMainPane(layout().root).id);
    expect(getWorkspaceSidePane(layout().root)).toBeNull();
  });

  it("reveals an existing tab where the user moved it", () => {
    const store = useWorkspaceLayoutStore.getState();
    const tabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/moved.ts" },
      intent: "reveal",
    });
    const mainPaneId = getWorkspaceMainPane(layout().root).id;
    store.moveTabToPane(WORKSPACE_KEY, tabId!, mainPaneId);

    expect(openPreferred({ kind: "file", path: "src/moved.ts" }, true)).toBe(tabId);
    expect(paneIdHolding(tabId)).toBe(mainPaneId);
    expect(layout().focusedPaneId).toBe(mainPaneId);
  });

  it("reopens a hidden side panel", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    });
    store.setSidePanelOpen(WORKSPACE_KEY, false);

    openPreferred({ kind: "file", path: "src/subagent.ts" });

    expect(selectIsWorkspaceSidePanelOpen(useWorkspaceLayoutStore.getState(), WORKSPACE_KEY)).toBe(
      true,
    );
  });

  it("opens a compact file in a sheet over the workspace", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");

    const tabId = openPreferred({ kind: "file", path: "src/sheet.ts" });

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.at(-1)?.tab.tabId).toBe(tabId);
    expect(getWorkspaceSidePane(layout().root)).toBeNull();
  });

  it("ignores a missing workspace", () => {
    expect(
      openPreferredWorkspaceTarget({
        workspaceKey: null,
        target: { kind: "file", path: "src/none.ts" },
        source: "diffFiles",
        preferences: DEFAULT_APP_SETTINGS.openInSidePane,
      }),
    ).toBeNull();
  });
});
