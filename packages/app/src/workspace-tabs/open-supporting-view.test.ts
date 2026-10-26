import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  getWorkspaceMainPane,
  getWorkspaceSidePane,
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  autoOpenWorkspacePullRequest,
  openComposerChanges,
  openWorkspaceChanges,
  openWorkspacePullRequest,
} from "@/workspace-tabs/open-supporting-view";

const WORKSPACE_KEY = "server-1:workspace-1";

function layout() {
  return useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
}

function sidePaneKinds() {
  const current = layout();
  const sidePane = current ? getWorkspaceSidePane(current.root) : null;
  if (!current || !sidePane) return [];
  const tabs = collectAllTabs(current.root);
  return sidePane.tabIds.map((tabId) => tabs.find((tab) => tab.tabId === tabId)?.target.kind);
}

function visibleSideKind() {
  const current = layout();
  const sidePane = current ? getWorkspaceSidePane(current.root) : null;
  if (!current || !sidePane) return undefined;
  return collectAllTabs(current.root).find((tab) => tab.tabId === sidePane.focusedTabId)?.target
    .kind;
}

function isSidePanelOpen() {
  return selectIsWorkspaceSidePanelOpen(useWorkspaceLayoutStore.getState(), WORKSPACE_KEY);
}

function openChat() {
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
}

beforeEach(() => {
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
  });
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    pullRequestTabAutoOpenedByWorkspace: {},
    layoutByWorkspace: {},
    sidePanelOpenByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("openWorkspaceChanges", () => {
  it("opens Changes in the side panel on compact widths", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");
    usePanelStore.getState().showMobileAgentList();
    openWorkspaceChanges({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(visibleSideKind()).toBe("changes");
    expect(isSidePanelOpen()).toBe(true);
  });
});

describe("openComposerChanges", () => {
  const input = {
    isCompact: false,
    workspaceKey: WORKSPACE_KEY,
    preferences: DEFAULT_APP_SETTINGS.openInSidePane,
  };

  it("opens the side panel on Changes when it is closed", () => {
    openChat();
    openComposerChanges(input);

    expect(isSidePanelOpen()).toBe(true);
    expect(visibleSideKind()).toBe("changes");
    expect(collectAllTabs(layout().root).map((tab) => tab.target.kind)).not.toContain(
      "working_diff",
    );
  });

  it("opens the diff beside Changes once the side panel shows it", () => {
    openChat();
    openComposerChanges(input);
    openComposerChanges(input);

    expect(sidePaneKinds()).toEqual(["changes", "working_diff"]);
    expect(visibleSideKind()).toBe("working_diff");
  });

  it("brings Changes forward when the side panel shows another tab", () => {
    openChat();
    openComposerChanges(input);
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    });
    openComposerChanges(input);

    expect(visibleSideKind()).toBe("changes");
    expect(sidePaneKinds()).not.toContain("working_diff");
  });

  it("reveals Changes again after the side panel was hidden", () => {
    openChat();
    openComposerChanges(input);
    useWorkspaceLayoutStore.getState().setSidePanelOpen(WORKSPACE_KEY, false);
    openComposerChanges(input);

    expect(isSidePanelOpen()).toBe(true);
    expect(sidePaneKinds()).toEqual(["changes"]);
  });

  it("keeps opening Changes on compact widths", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");
    openComposerChanges({ ...input, isCompact: true });
    openComposerChanges({ ...input, isCompact: true });

    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(sidePaneKinds()).toEqual(["changes"]);
  });
});

describe("openWorkspacePullRequest", () => {
  it.each(["main", "side", "explorer"] as const)(
    "opens the PR in the side panel when the preference is %s",
    (destination) => {
      openChat();
      openWorkspacePullRequest({ isCompact: false, workspaceKey: WORKSPACE_KEY, destination });

      expect(visibleSideKind()).toBe("pull_request");
      expect(isSidePanelOpen()).toBe(true);
      expect(getWorkspaceMainPane(layout().root).tabIds).toEqual(["agent_agent-1"]);
    },
  );

  it("opens the PR in the side panel on compact widths", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");
    usePanelStore.getState().showMobileAgentList();
    openWorkspacePullRequest({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      destination: DEFAULT_APP_SETTINGS.pullRequestOpenLocation,
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(visibleSideKind()).toBe("pull_request");
  });
});

describe("autoOpenWorkspacePullRequest", () => {
  it("silently adds the PR after Changes once, and never restores it after closing", () => {
    const store = useWorkspaceLayoutStore.getState();
    openChat();
    store.openTab({ workspaceKey: WORKSPACE_KEY, target: { kind: "changes" }, intent: "reveal" });
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    });
    store.focusPane(WORKSPACE_KEY, getWorkspaceMainPane(layout().root).id);
    const before = layout();

    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });

    const after = layout();
    expect(sidePaneKinds()).toEqual(["changes", "pull_request", "terminal"]);
    expect(getWorkspaceSidePane(after.root)!.focusedTabId).toBe(
      getWorkspaceSidePane(before.root)!.focusedTabId,
    );
    expect(after.focusedPaneId).toBe(before.focusedPaneId);

    store.closeTab(WORKSPACE_KEY, "pull_request");
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });
    expect(collectAllTabs(layout().root).map((tab) => tab.target.kind)).not.toContain(
      "pull_request",
    );
  });

  it("creates the side pane without taking focus from the chat", () => {
    openChat();
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });

    expect(sidePaneKinds()).toEqual(["pull_request"]);
    expect(layout().focusedPaneId).toBe(getWorkspaceMainPane(layout().root).id);
  });

  it("keeps a hidden side panel hidden", () => {
    const store = useWorkspaceLayoutStore.getState();
    openChat();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    });
    store.setSidePanelOpen(WORKSPACE_KEY, false);

    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });

    expect(sidePaneKinds()).toEqual(["terminal", "pull_request"]);
    expect(isSidePanelOpen()).toBe(false);
  });

  it("leaves a PR the user moved to the main pane where it is", () => {
    const store = useWorkspaceLayoutStore.getState();
    openChat();
    const tabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "pull_request" },
      intent: "background",
    });
    store.moveTabToPane(WORKSPACE_KEY, tabId!, getWorkspaceMainPane(layout().root).id);
    const before = layout();

    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });

    expect(layout()).toEqual(before);
    expect(getWorkspaceSidePane(layout().root)).toBeNull();
  });

  it("preserves reordering before and after detection", () => {
    const store = useWorkspaceLayoutStore.getState();
    openChat();
    store.openTab({ workspaceKey: WORKSPACE_KEY, target: { kind: "changes" }, intent: "reveal" });
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "pull_request" },
      intent: "background",
    });
    const sidePaneId = getWorkspaceSidePane(layout().root)!.id;
    store.reorderTabsInPane(WORKSPACE_KEY, sidePaneId, ["pull_request", "changes"]);
    const before = layout();

    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY });

    expect(layout()).toEqual(before);
  });
});
