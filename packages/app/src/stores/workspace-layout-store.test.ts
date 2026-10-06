import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";
import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutStore,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  getWorkspaceMainPane,
  getWorkspaceSidePane,
  normalizeLayout,
  selectIsWorkspaceSidePanelOpen,
  removePaneFromTree,
  removeTabFromTree,
  stripEphemeralTabsFromLayout,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";

function createDeterministicWorkspaceLayoutIds() {
  let values: string[] = [];
  let fallbackIndex = 0;

  function nextValue(): string {
    const value = values.shift();
    if (value) {
      return value;
    }
    fallbackIndex += 1;
    return `generated-${fallbackIndex}`;
  }

  return {
    useValues: (nextValues: string[]) => {
      values = nextValues.slice();
      fallbackIndex = 0;
    },
    reset: () => {
      values = [];
      fallbackIndex = 0;
    },
    createNodeId: (prefix: "pane" | "group") => `${prefix}_${nextValue()}`,
    createFocusRestorationToken: () => `workspace-focus-${nextValue()}`,
  };
}

const workspaceLayoutIds = createDeterministicWorkspaceLayoutIds();
const workspaceLayoutStore = createWorkspaceLayoutStore(workspaceLayoutIds);

function useWorkspaceLayoutIds(...values: string[]) {
  workspaceLayoutIds.useValues(values);
}

function createTab(tabId: string, target?: WorkspaceTab["target"]): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "draft", draftId: tabId },
    createdAt: 1,
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) => createTab(tabId, input.targetsByTabId?.[tabId]));
  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabIds: input.tabIds,
      focusedTabId: input.focusedTabId ?? input.tabIds[input.tabIds.length - 1] ?? null,
      tabs,
    } as SplitPane,
  };
}

function createWorkspaceKey(): string {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
  });
  expect(key).toBeTruthy();
  return key as string;
}

function expectGroup(node: SplitNode): Extract<SplitNode, { kind: "group" }> {
  expect(node.kind).toBe("group");
  return node as Extract<SplitNode, { kind: "group" }>;
}

describe("workspace-layout-store helpers", () => {
  it("finds panes and tabs across nested groups", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.4, 0.6],
        children: [
          createPane({ id: "left", tabIds: ["tab-a", "tab-b"], focusedTabId: "tab-a" }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-c"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-d"] }),
              ],
            },
          },
        ],
      },
    };

    expect(findPaneById(root, "top-right")?.tabIds).toEqual(["tab-c"]);
    expect(findPaneContainingTab(root, "tab-b")?.id).toBe("left");
    expect(collectAllPanes(root).map((pane) => pane.id)).toEqual([
      "left",
      "top-right",
      "bottom-right",
    ]);
    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual([
      "tab-a",
      "tab-b",
      "tab-c",
      "tab-d",
    ]);
  });

  it("derives the focused browser id from the focused pane active tab", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({
            id: "left",
            tabIds: ["agent-a", "browser-a"],
            focusedTabId: "browser-a",
            targetsByTabId: {
              "agent-a": { kind: "agent", agentId: "agent-a" },
              "browser-a": { kind: "browser", browserId: "browser-a-id" },
            },
          }),
          createPane({
            id: "right",
            tabIds: ["browser-b"],
            focusedTabId: "browser-b",
            targetsByTabId: {
              "browser-b": { kind: "browser", browserId: "browser-b-id" },
            },
          }),
        ],
      },
    };

    expect(getFocusedBrowserId({ root, focusedPaneId: "left" })).toBe("browser-a-id");
    expect(getFocusedBrowserId({ root, focusedPaneId: "right" })).toBe("browser-b-id");
  });

  it("returns null when the focused pane active tab is not a browser", () => {
    const root = createPane({
      id: "main",
      tabIds: ["browser-a", "agent-a"],
      focusedTabId: "agent-a",
      targetsByTabId: {
        "browser-a": { kind: "browser", browserId: "browser-a-id" },
        "agent-a": { kind: "agent", agentId: "agent-a" },
      },
    });

    expect(getFocusedBrowserId({ root, focusedPaneId: "main" })).toBeNull();
  });
});

describe("workspace-layout-store tree transforms", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
  });

  it("normalizeLayout flattens a persisted free-form split into main and side panes", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.25, 0.75],
        children: [
          createPane({
            id: "left",
            tabIds: ["agent_a", "terminal_t1"],
            focusedTabId: "terminal_t1",
            targetsByTabId: {
              agent_a: { kind: "agent", agentId: "a" },
              terminal_t1: { kind: "terminal", terminalId: "t1" },
            },
          }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({
                  id: "top-right",
                  tabIds: ["file_/a.ts"],
                  targetsByTabId: { "file_/a.ts": { kind: "file", path: "/a.ts" } },
                }),
                createPane({ id: "bottom-right", tabIds: ["draft-b"] }),
              ],
            },
          },
        ],
      },
    };

    const layout = normalizeLayout({ root, focusedPaneId: "top-right" });
    const group = expectGroup(layout.root);

    expect(group.group.direction).toBe("horizontal");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["left", "top-right"]);
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["agent_a", "draft-b"]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["terminal_t1", "file_/a.ts"]);
    expect(getWorkspaceSidePane(layout.root)?.focusedTabId).toBe("terminal_t1");
    expect(layout.focusedPaneId).toBe("top-right");
  });

  it("normalizeLayout keeps a layout without side-panel tabs to its main pane", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "vertical",
        sizes: [0.5, 0.5],
        children: [
          createPane({ id: "top", tabIds: ["draft-a"] }),
          createPane({ id: "bottom", tabIds: ["draft-b"] }),
        ],
      },
    };

    const layout = normalizeLayout({ root, focusedPaneId: "bottom" });

    expect(layout.root.kind).toBe("pane");
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["draft-a", "draft-b"]);
    expect(getWorkspaceSidePane(layout.root)).toBeNull();
    expect(layout.focusedPaneId).toBe("top");
  });

  it("removePaneFromTree unwraps single-child groups and renormalizes siblings", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.2, 0.8],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-b"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
              ],
            },
          },
        ],
      },
    };

    const nextRoot = removePaneFromTree(root, "top-right");
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.sizes).toEqual([0.2, 0.8]);
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual(["left", "bottom-right"]);
    expect(nextGroup.group.children[1]).toEqual(
      createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
    );
  });

  it("removeTabFromTree collapses empty panes but keeps the final root pane", () => {
    const splitRoot: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b"] }),
        ],
      },
    };

    const collapsed = removeTabFromTree(splitRoot, "tab-a");
    expect(collapsed).toEqual(createPane({ id: "right", tabIds: ["tab-b"] }));

    const singlePaneRoot = createPane({ id: "main", tabIds: ["tab-a"] });
    const emptied = removeTabFromTree(singlePaneRoot, "tab-a");
    expect(emptied).toEqual(createPane({ id: "main", tabIds: [], focusedTabId: null }));
  });
});

describe("workspace-layout-store actions", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      sidePanelOpenByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
      focusRestorationByWorkspace: {},
    });
  });

  it("routes chats to the main pane and side-panel tabs to a side pane it creates", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const terminalTabId = store.openTabFocused(workspaceKey, {
      kind: "terminal",
      terminalId: "term-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const group = expectGroup(layout.root);

    expect(group.group.id).toBe("group_generated-1");
    expect(group.group.direction).toBe("horizontal");
    expect(getWorkspaceMainPane(layout.root)).toMatchObject({
      id: "main",
      tabIds: [draftTabId],
      focusedTabId: draftTabId,
    });
    expect(getWorkspaceSidePane(layout.root)).toMatchObject({
      id: "pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      tabIds: [fileTabId, terminalTabId],
      focusedTabId: terminalTabId,
    });
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    const agentTabId = store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const layoutAfterAgent = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(getWorkspaceMainPane(layoutAfterAgent.root).tabIds).toEqual([draftTabId, agentTabId]);
    expect(layoutAfterAgent.focusedPaneId).toBe("main");
  });

  it("focuses duplicate opens instead of creating a second tab", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe("file_/repo/worktree/b.ts");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("updates an existing file tab when opening the same path at a new line range", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
      lineStart: 5,
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
      lineStart: 10,
      lineEnd: 12,
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe(firstTabId);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: "file_/repo/worktree/a.ts",
        target: {
          kind: "file",
          path: "/repo/worktree/a.ts",
          lineStart: 10,
          lineEnd: 12,
        },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("openTabInBackground inserts a tab without stealing focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const setupTabId = store.openTabInBackground(workspaceKey, {
      kind: "setup",
      workspaceId: "ws-main",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;
    const sidePane = getWorkspaceSidePane(layout.root)!;

    expect(agentTabId).toBe("agent_agent-1");
    expect(setupTabId).toBe("setup_ws-main");
    // Setup is a side panel tab; it lands there without taking focus.
    expect(pane.tabIds).toEqual([agentTabId]);
    expect(sidePane.tabIds).toEqual([setupTabId]);
    expect(pane.focusedTabId).toBe(agentTabId);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("openTabInBackground on an existing target is a no-op", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const duplicateTabId = store.openTabInBackground(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const layoutAfter = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = getWorkspaceSidePane(layoutAfter.root)!;

    expect(duplicateTabId).toBe(firstTabId);
    expect(pane.tabIds).toEqual([firstTabId, secondTabId]);
    expect(pane.focusedTabId).toBe(secondTabId);
  });

  it("closing a focused middle tab selects the tab to its right", () => {
    const workspaceKey = createWorkspaceKey();
    const firstTabId = "draft-1";
    const closedTabId = "draft-2";
    const rightTabId = "draft-3";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [firstTabId, closedTabId, rightTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([firstTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(rightTabId);
  });

  it("closing a focused child tab returns to its parent before using tab-strip order", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const parentTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-parent",
    });
    const childTabId = store.openChildTabFocused(
      workspaceKey,
      { kind: "draft", draftId: "draft-child" },
      parentTabId!,
    );
    const rightTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-right",
    });
    store.focusTab(workspaceKey, childTabId!);

    workspaceLayoutStore.getState().closeTab(workspaceKey, childTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([parentTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(parentTabId);
  });

  it("closing a focused last tab selects the tab to its left", () => {
    const workspaceKey = createWorkspaceKey();
    const leftTabId = "draft-1";
    const closedTabId = "draft-2";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [leftTabId, closedTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([leftTabId]);
    expect(pane.focusedTabId).toBe(leftTabId);
  });

  it("unfocuses and restores the previous focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const token = store.unfocusPane(workspaceKey);
    expect(token).toBeTruthy();
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, token!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("does not restore stale focus after another pane is focused", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    store.focusPane(workspaceKey, "main");

    const token = store.unfocusPane(workspaceKey);
    store.focusPane(workspaceKey, "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    store.restorePaneFocus(workspaceKey, token!);

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });

  it("waits for nested focus restorations before restoring", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const outerToken = store.unfocusPane(workspaceKey);
    const innerToken = store.unfocusPane(workspaceKey);

    store.restorePaneFocus(workspaceKey, outerToken!);
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, innerToken!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("openTab creates distinct draft tabs for repeated Cmd+T/new-tab opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const secondTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-2" });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("draft-1");
    expect(secondTabId).toBe("draft-2");
    expect(firstTabId).not.toBe(secondTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([firstTabId, secondTabId]);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: firstTabId,
        target: { kind: "draft", draftId: "draft-1" },
        createdAt: expect.any(Number),
      },
      {
        tabId: secondTabId,
        target: { kind: "draft", draftId: "draft-2" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("opening the side panel without side tabs creates an empty side pane and focuses it", () => {
    useWorkspaceLayoutIds("77777777-7777-7777-7777-777777777777");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.setSidePanelOpen(workspaceKey, true);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(getWorkspaceSidePane(layout.root)).toMatchObject({
      id: "pane_77777777-7777-7777-7777-777777777777",
      tabIds: [],
    });
    expect(layout.focusedPaneId).toBe("pane_77777777-7777-7777-7777-777777777777");
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      true,
    );

    // A chat opened while the empty side pane is focused still lands in main.
    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-2" });
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["draft-1", draftTabId]);
    expect(layout.focusedPaneId).toBe("main");

    // Hiding an empty side panel drops the pane it created.
    store.setSidePanelOpen(workspaceKey, false);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.root.kind).toBe("pane");
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      false,
    );
  });

  it("hiding the side panel keeps its tabs and focusing one of them reveals it again", () => {
    useWorkspaceLayoutIds("88888888-8888-8888-8888-888888888888");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });

    store.toggleSidePanel(workspaceKey);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      false,
    );
    expect(layout.focusedPaneId).toBe("main");
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual([fileTabId]);

    store.focusTab(workspaceKey, fileTabId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      true,
    );
    expect(layout.focusedPaneId).toBe("pane_88888888-8888-8888-8888-888888888888");

    store.setSidePanelOpen(workspaceKey, false);
    store.focusTab(workspaceKey, draftTabId!);
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      false,
    );

    // A background open into the hidden side pane leaves it hidden.
    store.openTabInBackground(workspaceKey, { kind: "terminal", terminalId: "term-1" });
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      false,
    );

    // A focused open into it reveals it.
    store.openTabFocused(workspaceKey, { kind: "terminal", terminalId: "term-2" });
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      true,
    );
  });

  it("focusTab moves workspace focus to the pane containing the tab", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const terminalTabId = store.openTabFocused(workspaceKey, {
      kind: "terminal",
      terminalId: "term-1",
    });

    store.focusTab(workspaceKey, draftTabId!);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusTab(workspaceKey, terminalTabId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
    const sidePaneId = "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(layout.focusedPaneId).toBe(sidePaneId);
    expect(findPaneById(layout.root, sidePaneId)?.focusedTabId).toBe(terminalTabId);
  });

  it("convertDraftToAgent replaces the draft tab with a canonical agent tab in the same pane", () => {
    useWorkspaceLayoutIds("12121212-1212-1212-1212-121212121212");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-2" });

    const nextTabId = store.convertDraftToAgent(workspaceKey, secondTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const mainPane = getWorkspaceMainPane(layout.root);
    const convertedTab = collectAllTabs(layout.root).find((tab) => tab.tabId === nextTabId);

    expect(nextTabId).toBe("agent_agent-1");
    expect(mainPane.tabIds).toEqual(["agent_agent-1"]);
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe("main");
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["file_/repo/worktree/a.ts"]);
    expect(convertedTab).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: expect.any(Number),
    });
  });

  it("retargetTab keeps a draft tab in place while updating its target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-retarget",
    });
    const nextTabId = store.retargetTab(workspaceKey, draftTabId!, {
      kind: "file",
      path: "/repo/worktree/retargeted.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(draftTabId).toBe("draft-retarget");
    expect(nextTabId).toBe(draftTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([draftTabId!]);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: draftTabId!,
        target: { kind: "file", path: "/repo/worktree/retargeted.ts" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("retargetTab gives a non-draft tab the new target identity", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTabFocused(workspaceKey, {
      kind: "agent",
      agentId: "agent-retarget",
    });
    const nextTabId = store.retargetTab(workspaceKey, agentTabId!, {
      kind: "draft",
      draftId: "draft-from-agent",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(agentTabId).toBe("agent_agent-retarget");
    expect(nextTabId).toBe("draft-from-agent");
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["draft-from-agent"]);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: "draft-from-agent",
        target: { kind: "draft", draftId: "draft-from-agent" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("retargetTab closes a draft tab and focuses the existing canonical target tab", () => {
    useWorkspaceLayoutIds("55555555-5555-5555-5555-555555555555");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const existingFileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-dup" });
    const secondDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-dup-2",
    });

    const nextTabId = store.retargetTab(workspaceKey, secondDraftTabId!, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const sidePaneId = "pane_55555555-5555-5555-5555-555555555555";

    expect(existingFileTabId).toBe("file_/repo/worktree/existing.ts");
    expect(draftTabId).toBe("draft-dup");
    expect(nextTabId).toBe(existingFileTabId);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      draftTabId!,
      existingFileTabId!,
    ]);
    expect(layout.focusedPaneId).toBe(sidePaneId);
    expect(findPaneById(layout.root, sidePaneId)?.focusedTabId).toBe(existingFileTabId);
  });

  it("retargetTab closes a draft tab and focuses an existing matching target tab", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-agent-1",
    });
    const firstAgentTabId = store.retargetTab(workspaceKey, firstDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const secondDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-agent-2",
    });

    const nextTabId = store.retargetTab(workspaceKey, secondDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstAgentTabId).toBe(firstDraftTabId);
    expect(nextTabId).toBe(firstDraftTabId);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: firstDraftTabId!,
        target: { kind: "agent", agentId: "agent-1" },
        createdAt: expect.any(Number),
      },
    ]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(firstDraftTabId);
  });

  it("reorderTabs reorders tabs within the focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-a" });
    const secondTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-b" });
    const thirdTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-c" });

    store.reorderTabs(workspaceKey, [thirdTabId!, firstTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(layout.root, "main")).toEqual({
      id: "main",
      tabIds: [thirdTabId!, firstTabId!, secondTabId!],
      focusedTabId: thirdTabId,
      tabs: [
        {
          tabId: thirdTabId,
          target: { kind: "draft", draftId: "draft-c" },
          createdAt: expect.any(Number),
        },
        {
          tabId: firstTabId,
          target: { kind: "draft", draftId: "draft-a" },
          createdAt: expect.any(Number),
        },
        {
          tabId: secondTabId,
          target: { kind: "draft", draftId: "draft-b" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("reorderTabsInPane reorders tabs in the requested pane without changing focused pane", () => {
    useWorkspaceLayoutIds("34343434-3434-3434-3434-343434343434");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const thirdTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/c.ts",
    });
    const fourthTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/d.ts",
    });
    const sidePaneId = "pane_34343434-3434-3434-3434-343434343434";

    store.focusPane(workspaceKey, "main");
    store.reorderTabsInPane(workspaceKey, sidePaneId, [fourthTabId!, thirdTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, sidePaneId)).toEqual({
      id: sidePaneId,
      tabIds: [fourthTabId!, thirdTabId!],
      focusedTabId: fourthTabId,
      tabs: [
        {
          tabId: fourthTabId,
          target: { kind: "file", path: "/repo/worktree/d.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("focusPane switches workspace focus to a different pane", () => {
    useWorkspaceLayoutIds("56565656-5656-5656-5656-565656565656");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/b.ts" });
    const sidePaneId = "pane_56565656-5656-5656-5656-565656565656";

    store.focusPane(workspaceKey, "main");
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusPane(workspaceKey, sidePaneId);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;

    expect(layout.focusedPaneId).toBe(sidePaneId);
  });

  it("closeTab keeps an emptied side pane so the panel stays open on its launcher", () => {
    useWorkspaceLayoutIds("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const sidePaneId = "pane_cccccccc-cccc-cccc-cccc-cccccccccccc";

    store.closeTab(workspaceKey, fileTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", sidePaneId]);
    expect(layout.focusedPaneId).toBe(sidePaneId);
  });

  it("hiding the panel is what drops a side pane emptied by closeTab", () => {
    useWorkspaceLayoutIds("cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });

    store.closeTab(workspaceKey, fileTabId!);
    store.setSidePanelOpen(workspaceKey, false);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps a single side pane however many side-panel tabs open", () => {
    useWorkspaceLayoutIds("11111111-1111-1111-1111-111111111111");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    store.openTabFocused(workspaceKey, { kind: "terminal", terminalId: "term-1" });
    store.openTabFocused(workspaceKey, { kind: "browser", browserId: "browser-1" });
    store.openTabFocused(workspaceKey, { kind: "working_diff" });
    store.openTabFocused(workspaceKey, { kind: "changes" });
    store.openTabFocused(workspaceKey, { kind: "files" });
    store.openTabFocused(workspaceKey, { kind: "pull_request" });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([
      "main",
      "pane_11111111-1111-1111-1111-111111111111",
    ]);
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual([]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual([
      "file_/repo/worktree/a.ts",
      "terminal_term-1",
      "browser_browser-1",
      "working_diff",
      "changes",
      "files",
      "pull_request",
    ]);
  });

  it("moveTabToPane collapses the side pane when its last tab moves to main", () => {
    useWorkspaceLayoutIds("dddddddd-dddd-dddd-dddd-dddddddddddd");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });

    store.moveTabToPane(workspaceKey, fileTabId!, "main");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe("main");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([draftTabId, fileTabId]);
  });

  it("moveTabToPane keeps an emptied main pane so the side pane is never promoted", () => {
    useWorkspaceLayoutIds("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const sidePaneId = "pane_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    store.moveTabToPane(workspaceKey, draftTabId!, sidePaneId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", sidePaneId]);
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual([]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual([fileTabId, draftTabId]);
    expect(layout.focusedPaneId).toBe(sidePaneId);
  });

  it("closeTab keeps an emptied main pane beside the side pane", () => {
    useWorkspaceLayoutIds("78787878-7878-7878-7878-787878787878");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    store.focusTab(workspaceKey, draftTabId!);

    store.closeTab(workspaceKey, draftTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const rootGroup = expectGroup(layout.root);

    expect(rootGroup.group.direction).toBe("horizontal");
    expect(
      collectAllPanes(layout.root).map((pane) => ({ id: pane.id, tabIds: pane.tabIds })),
    ).toEqual([
      { id: "main", tabIds: [] },
      { id: "pane_78787878-7878-7878-7878-787878787878", tabIds: [fileTabId] },
    ]);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("openTab focuses the existing tab instead of creating a duplicate entry", () => {
    useWorkspaceLayoutIds("abababab-abab-abab-abab-abababababab");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const sidePaneId = "pane_abababab-abab-abab-abab-abababababab";

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe(sidePaneId);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("persists working diff tabs while stripping commit diff tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, {
      kind: "working_diff",
      focusPath: "src/a.ts",
    });
    store.openTabFocused(workspaceKey, { kind: "commit_diff", sha: "abc123" });

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    if (!partialize) {
      throw new Error("Workspace layout partialize function is missing");
    }
    const currentState = workspaceLayoutStore.getState();
    const layout = stripEphemeralTabsFromLayout(currentState.layoutByWorkspace[workspaceKey]);
    const persisted = partialize(currentState);

    expect(persisted).toEqual({
      layoutByWorkspace: { [workspaceKey]: layout },
      splitSizesByWorkspace: currentState.splitSizesByWorkspace,
      sidePanelOpenByWorkspace: currentState.sidePanelOpenByWorkspace,
    });
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target)).toEqual([
      {
        kind: "working_diff",
        focusPath: "src/a.ts",
      },
    ]);
  });

  it("canonicalizes comparison-specific working diff tab ids from persisted layouts", () => {
    const legacyTabId = "working_diff_uncommitted_0_n";
    const layout = normalizeLayout({
      root: {
        kind: "pane",
        pane: {
          id: "main",
          tabIds: [legacyTabId],
          focusedTabId: legacyTabId,
          tabs: [
            {
              tabId: legacyTabId,
              createdAt: 1,
              target: {
                kind: "working_diff",
                focusPath: "src/a.ts",
                mode: "uncommitted",
                baseRef: null,
                ignoreWhitespace: false,
              },
            },
          ],
        },
      },
      focusedPaneId: "main",
    });

    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: "working_diff",
        target: { kind: "working_diff", focusPath: "src/a.ts" },
        createdAt: 1,
      },
    ]);
  });

  it("resizeSplit keeps sizes normalized while enforcing the minimum proportion", () => {
    useWorkspaceLayoutIds("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/b.ts" });

    const splitRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const splitGroup = expectGroup(splitRoot);
    expect(splitGroup.group.sizes[0]).toBeCloseTo(0.58, 10);
    expect(splitGroup.group.sizes[1]).toBeCloseTo(0.42, 10);
    store.resizeSplit(workspaceKey, splitGroup.group.id, [0.01, 0.99]);

    const sizes =
      workspaceLayoutStore.getState().splitSizesByWorkspace[workspaceKey]?.[splitGroup.group.id];
    const total = sizes!.reduce((sum, size) => sum + size, 0);

    expect(sizes![0]).toBeGreaterThanOrEqual(0.1);
    expect(sizes![1]).toBeGreaterThanOrEqual(0.1);
    expect(total).toBeCloseTo(1, 10);
  });

  it("closing the last tab keeps a single empty pane in the layout", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const tabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.closeTab(workspaceKey, tabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout).toEqual(createDefaultLayout());
  });

  it("keeps pinned archived agents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unpinAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.pinnedAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      sidePanelOpenByWorkspace: {},
    });
  });

  it("keeps hidden agent intents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unhideAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      sidePanelOpenByWorkspace: {},
    });
  });

  it("convertDraftToAgent removes the draft and focuses the existing canonical agent tab", () => {
    useWorkspaceLayoutIds("67676767-6767-6767-6767-676767676767");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-existing",
    });
    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    store.focusTab(workspaceKey, draftTabId!);

    const nextTabId = store.convertDraftToAgent(workspaceKey, draftTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(nextTabId).toBe("agent_agent-1");
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs canonicalizes duplicates and prunes stale entity tabs from hydrated snapshots", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft_agent", "agent_agent-1", "terminal_orphan", "draft-1"],
              focusedTabId: "draft_agent",
              tabs: [
                {
                  tabId: "draft_agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
                {
                  tabId: "agent_agent-1",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 2,
                },
                {
                  tabId: "terminal_orphan",
                  target: { kind: "terminal", terminalId: "term-stale" },
                  createdAt: 3,
                },
                {
                  tabId: "draft-1",
                  target: { kind: "draft", draftId: "draft-1" },
                  createdAt: 4,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
      pinnedAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-2"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1", "agent-2"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabs = collectAllTabs(layout.root);

    expect(tabs.map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
      "draft-1",
      "agent_agent-2",
      "terminal_term-1",
    ]);
    expect(tabs.find((tab) => tab.tabId === "agent_agent-1")).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: 2,
    });
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs preserves a draft-origin agent tab id when there is no duplicate", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft-agent"],
              focusedTabId: "draft-agent",
              tabs: [
                {
                  tabId: "draft-agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: "draft-agent",
        target: { kind: "agent", agentId: "agent-1" },
        createdAt: 1,
      },
    ]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("draft-agent");
  });

  it("reconcileTabs does not re-add locally hidden agent tabs", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      hiddenAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-1"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);
  });

  it("reconcileTabs does not auto-open subagents omitted from autoOpenAgentIds", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_parent-agent"]);
  });

  it("reconcileTabs keeps manually opened subagent tabs that remain active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_child-agent", "agent_parent-agent"]);
  });

  it("reconcileTabs prunes archived subagent tabs that are no longer active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_parent-agent"]);
  });

  it("openTabFocused reopens hidden subagent tabs and clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "child-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["child-agent"],
      autoOpenAgentIds: [],
      knownAgentIds: ["child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_child-agent",
    ]);
  });

  it("reconcileTabs auto-opens only standalone terminals while keeping explicitly opened live terminals", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const scriptTabId = store.openTabFocused(workspaceKey, {
      kind: "terminal",
      terminalId: "term-script",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script", "term-manual"],
      standaloneTerminalIds: ["term-manual"],
      hasActivePendingDraftCreate: false,
    });

    const tabs = workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(tabs.map((tab) => tab.tabId)).toEqual(["terminal_term-script", "terminal_term-manual"]);
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(scriptTabId);
  });

  it("reconcileTabs does not auto-open live non-standalone terminals", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);
  });

  it("explicitly opening an agent tab clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
  });

  it("pinning an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    expect(workspaceLayoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey]).toBeDefined();

    store.pinAgent(workspaceKey, "agent-1");

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
  });

  it("keeps an explicitly pinned archived agent before its detail is hydrated", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "archived-agent" });
    store.pinAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(store.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_archived-agent",
    ]);

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(store.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_archived-agent",
    ]);

    store.resolvePendingAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(store.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([]);

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "archived-agent" });
    store.pinAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(store.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_archived-agent",
    ]);
  });

  it("retargeting a tab to an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    const tabId = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    store.retargetTab(workspaceKey, tabId!, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });
});
