import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { setPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { createViewedTimelineSync } from "@/timeline/viewed-timeline-sync";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";
import { defaultChangesState, type ChangesState } from "@/panels/changes/state";
import { defaultFileState, type FileState } from "@/panels/file/state";
import {
  canDismissPaneInLayout,
  collectAllPanes,
  collectAllTabs,
  selectPaneFocusSuspended,
  createWorkspaceLayoutStore,
  observeOpenWorkspaceAgentIds,
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

it("bumps panel params revision when the same tab is opened again", () => {
  const storage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  const store = createWorkspaceLayoutStore(workspaceLayoutIds, storage);
  const workspaceKey = "server-1:workspace-params";
  const targets = [
    { kind: "file" as const, path: "notes.md", lineStart: 3 },
    {
      kind: "plugin" as const,
      pluginId: "notes",
      panelId: "workspace",
      context: "workspace" as const,
    },
    {
      kind: "plugin" as const,
      pluginId: "notes",
      panelId: "agent",
      context: "agent" as const,
      agentId: "agent-1",
    },
  ];
  for (const target of targets) {
    const first = store.getState().openTab({ workspaceKey, target, intent: "reveal" })!;
    const revision = store.getState().panelRevisionByWorkspace[workspaceKey][first];
    const second = store.getState().openTab({ workspaceKey, target, intent: "reveal" });
    expect(second).toBe(first);
    expect(store.getState().panelRevisionByWorkspace[workspaceKey][first]).toBe(revision + 1);
  }
});

it("observes open chats across unmounted workspaces until their tabs close", () => {
  const store = createWorkspaceLayoutStore(workspaceLayoutIds);
  store.setState({ layoutByWorkspace: {} });
  const received: string[][] = [];
  const stop = observeOpenWorkspaceAgentIds("server-1", (ids) => received.push(ids), store);
  const first = store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "agent-a" },
    intent: "reveal",
  });
  store.getState().openTab({
    workspaceKey: "server-1:workspace-b",
    target: { kind: "agent", agentId: "agent-b" },
    intent: "background",
  });
  store.getState().openTab({
    workspaceKey: "server-2:workspace-a",
    target: { kind: "agent", agentId: "other-host-agent" },
    intent: "reveal",
  });
  expect(received).toEqual([[], ["agent-a"], ["agent-a", "agent-b"]]);
  if (!first) throw new Error("Expected an open agent tab");
  store.getState().closeTab("server-1:workspace-a", first);
  expect(received.at(-1)).toEqual(["agent-b"]);
  stop();
  store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "after-dispose" },
    intent: "reveal",
  });
  expect(received).toEqual([[], ["agent-a"], ["agent-a", "agent-b"], ["agent-b"]]);
});

it("feeds restored layout to timeline sync as a release signal, not a subscription source", async () => {
  const store = createWorkspaceLayoutStore(workspaceLayoutIds);
  store.setState({ layoutByWorkspace: {} });
  // Launch: layout rehydrates tabs the user opened in earlier sessions.
  const restored = store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "agent-a" },
    intent: "reveal",
  });
  store.getState().openTab({
    workspaceKey: "server-1:workspace-b",
    target: { kind: "agent", agentId: "agent-b" },
    intent: "background",
  });

  const observed: string[][] = [];
  const sync = createViewedTimelineSync({
    replaceDemandedAgentIds: () => undefined,
    prepare: async () => undefined,
    observe: (agentIds) => {
      observed.push(agentIds);
      return { ready: Promise.resolve(), release: async () => undefined };
    },
    readCursor: () => undefined,
    fetchPage: async () => ({ hasNewer: false, endCursor: null }),
    fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
    onCatchUpEnded: () => undefined,
    reportError: () => undefined,
    schedule: () => () => undefined,
  });
  // The edge session-context.tsx owns. Pointing it at subscription instead would resume every
  // agent behind a restored tab on the daemon.
  const stop = observeOpenWorkspaceAgentIds(
    "server-1",
    (agentIds) => sync.replaceOpenTabAgentIds(agentIds),
    store,
  );

  sync.setConnected(true);
  expect(observed).toEqual([]);

  sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  await vi.waitFor(() => expect(observed).toEqual([["agent-a"]]));

  if (!restored) throw new Error("Expected an open agent tab");
  store.getState().closeTab("server-1:workspace-a", restored);
  sync.replaceVisibleAgentIds("workspace", []);
  await vi.waitFor(() => expect(observed.at(-1)).toEqual([]));

  stop();
  sync.dispose();
});

function useWorkspaceLayoutIds(...values: string[]) {
  workspaceLayoutIds.useValues(values);
}

function createTab(
  tabId: string,
  target?: WorkspaceTab["target"],
  state?: WorkspaceTab["state"],
): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "draft", draftId: tabId },
    createdAt: 1,
    ...(state === undefined ? {} : { state }),
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
  stateByTabId?: Record<string, WorkspaceTab["state"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) =>
    createTab(tabId, input.targetsByTabId?.[tabId], input.stateByTabId?.[tabId]),
  );
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

function createSidePanelRoot(main: SplitNode, side: SplitNode): SplitNode {
  return {
    kind: "group",
    group: {
      id: "group-root",
      direction: "horizontal",
      sizes: [0.58, 0.42],
      children: [main, side],
    },
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

function collectTabIds(root: SplitNode): string[] {
  return collectAllTabs(root).map((tab) => tab.tabId);
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
      pullRequestTabAutoOpenedByWorkspace: {},
      sheetsByWorkspace: {},
    });
  });

  it("routes chats to the main pane and side-panel tabs to a side pane it creates", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const terminalTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
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

    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const layoutAfterAgent = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(getWorkspaceMainPane(layoutAfterAgent.root).tabIds).toEqual([draftTabId, agentTabId]);
    expect(layoutAfterAgent.focusedPaneId).toBe("main");
  });

  it("focuses duplicate opens instead of creating a second tab", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe("file_/repo/worktree/b.ts");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(collectTabIds(layout.root)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("updates an existing file tab when opening the same path at a new line range", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts", lineStart: 5 },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts", lineStart: 10, lineEnd: 12 },
      intent: "reveal",
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

  it("openTab background intent inserts a tab without stealing focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const setupTabId = store.openTab({
      workspaceKey,
      target: { kind: "setup", workspaceId: "ws-main" },
      intent: "background",
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

  it("openTab background intent on an existing target is a no-op", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const duplicateTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "background",
    });
    const layoutAfter = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = getWorkspaceSidePane(layoutAfter.root)!;

    expect(duplicateTabId).toBe(firstTabId);
    expect(pane.tabIds).toEqual([firstTabId, secondTabId]);
    expect(pane.focusedTabId).toBe(secondTabId);
  });

  it("creates duplicate Changes instances while reveal keeps the first instance", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    });
    const second = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    });

    expect(first).not.toBe(second);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).filter(
        (tab) => tab.target.kind === "working_diff",
      ),
    ).toHaveLength(2);

    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: { kind: "working_diff" },
        intent: "reveal",
      }),
    ).toBe(first);
  });

  it("creates duplicate Pull request instances explicitly", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({ workspaceKey, target: { kind: "pull_request" }, intent: "new" });
    const second = store.openTab({ workspaceKey, target: { kind: "pull_request" }, intent: "new" });
    expect(first).not.toBe(second);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).filter(
        (tab) => tab.target.kind === "pull_request",
      ),
    ).toHaveLength(2);
  });

  it("preserves same-kind state, clears cross-kind state, and accepts an explicit override", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const file = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "new",
    })!;
    const fileState: FileState = { treeVisible: true, treeWidth: 240 };
    store.setTabState(workspaceKey, file, fileState);
    const sameKind = store.replaceTab(workspaceKey, file, { kind: "file", path: "/repo/b.ts" });
    expect(sameKind).toBe(file);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === sameKind,
      )?.state,
    ).toEqual(fileState);
    const crossKind = store.replaceTab(workspaceKey, sameKind!, { kind: "working_diff" });
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === crossKind,
      )?.state,
    ).toBeUndefined();
    const override: ChangesState = { ...defaultChangesState, treeVisible: true };
    const overridden = store.replaceTab(
      workspaceKey,
      crossKind!,
      { kind: "working_diff" },
      override,
    );
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === overridden,
      )?.state,
    ).toEqual(override);
  });

  it("keeps the tab instance when a panel receives a same-kind replacement", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "working_diff", focusPath: "src/a.ts", focusRequestId: 1 },
      intent: "new",
    })!;
    const state: ChangesState = { ...defaultChangesState, collapsedFilePaths: ["src/a.ts"] };
    store.setTabState(workspaceKey, tabId, state);

    const replacementTabId = store.replaceTab(workspaceKey, tabId, {
      kind: "working_diff",
      focusPath: "src/b.ts",
      focusRequestId: 2,
    });
    const replacement = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    ).find((tab) => tab.tabId === tabId);

    expect(replacementTabId).toBe(tabId);
    expect(replacement).toMatchObject({
      tabId,
      target: { kind: "working_diff", focusPath: "src/b.ts", focusRequestId: 2 },
      state,
    });
  });

  it("keeps every local Changes field independent across explicit instances", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    })!;
    const second = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    })!;
    const changed: ChangesState = {
      treeVisible: true,
      treeWidth: 320,
      collapsedFilePaths: ["a.ts"],
      collapsedFolderPaths: ["src"],
      commitsCollapsed: false,
    };
    store.setTabState(workspaceKey, first, changed);
    const tabs = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    );
    expect(tabs.find((tab) => tab.tabId === first)?.state).toEqual(changed);
    expect(tabs.find((tab) => tab.tabId === second)?.state).toEqual(undefined);
  });

  it("restores a revealed file's parent after local replacement", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const file = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts", lineStart: 1 },
      intent: "new",
    })!;
    store.setTabState(workspaceKey, file, {
      treeVisible: true,
      treeWidth: 300,
    });
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: { kind: "file", path: "/repo/a.ts", lineStart: 9 },
        intent: "reveal",
        placement: undefined,
        parentTabId: parent,
      }),
    ).toBe(file);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === file)).toMatchObject({
      target: { path: "/repo/a.ts", lineStart: 9 },
      state: { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    });
    expect(layout.parentTabIdByTabId?.[file]).toBe(parent);

    const replacement = store.replaceTab(
      workspaceKey,
      file,
      { kind: "file", path: "/repo/b.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    );
    expect(replacement).toBe(file);
    const replacedLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(replacedLayout.parentTabIdByTabId?.[file]).toBe(parent);

    store.closeTab(workspaceKey, replacement as string);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("keeps existing child edges attached to a replacement tab", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const replaced = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "pull_request" },
      intent: "new",
    })!;
    const child = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      parentTabId: replaced,
    })!;
    const unrelatedParent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "unrelated" },
      intent: "new",
    })!;
    const unrelatedChild = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/unrelated.ts" },
      intent: "reveal",
      parentTabId: unrelatedParent,
    })!;

    const replacement = store.replaceTab(
      workspaceKey,
      replaced,
      { kind: "file", path: "/repo/b.ts" },
      { ...defaultFileState, treeVisible: true },
    )!;
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.parentTabIdByTabId?.[child]).toBe(replacement);
    expect(layout.parentTabIdByTabId?.[unrelatedChild]).toBe(unrelatedParent);
    expect(Object.entries(layout.parentTabIdByTabId ?? {}).flat()).not.toContain(replaced);

    store.focusTab(workspaceKey, child);
    store.closeTab(workspaceKey, child);
    expect(
      getWorkspaceSidePane(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root)
        ?.focusedTabId,
    ).toBe(replacement);
  });

  it("reveals provider children through the child capability in a pane-local open", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const target = {
      kind: "provider_subagent" as const,
      parentAgentId: "parent",
      subagentId: "provider-child",
    };
    const mainPanePlacement = { mode: "pane" as const, paneId: "main" };

    const child = store.openTab({
      workspaceKey: workspaceKey,
      target: target,
      intent: "reveal",
      parentTabId: parent,
      placement: mainPanePlacement,
    })!;
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: target,
        intent: "reveal",
        parentTabId: parent,
        placement: mainPanePlacement,
      }),
    ).toBe(child);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, child)?.id).toBe("main");
    expect(layout.parentTabIdByTabId?.[child]).toBe(parent);

    store.closeTab(workspaceKey, child);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("replaces only the supplied file slot and carries its state", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const preserved = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "new",
    });
    const local = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/b.ts" },
      intent: "new",
    });

    const replacement = store.replaceTab(
      workspaceKey,
      local as string,
      { kind: "file", path: "/repo/a.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 280 },
    );

    const tabs = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    );
    expect(replacement).not.toBe(preserved);
    expect(tabs.find((tab) => tab.tabId === preserved)?.target).toEqual({
      kind: "file",
      path: "/repo/a.ts",
    });
    expect(tabs.find((tab) => tab.tabId === replacement)?.state).toEqual({
      ...defaultFileState,
      treeVisible: true,
      treeWidth: 280,
    });
  });

  it("replaces the side pane's sole New tab when real content opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {
        [workspaceKey]: normalizeLayout({
          root: createSidePanelRoot(
            createPane({ id: "main", tabIds: ["draft-1"] }),
            createPane({
              id: "side",
              tabIds: ["tab_new"],
              targetsByTabId: { tab_new: { kind: "new_tab" } },
            }),
          ),
          focusedPaneId: "main",
        }),
      },
    });

    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "background",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "side")?.tabIds).toEqual([fileTabId]);
    expect(findPaneById(layout.root, "side")?.focusedTabId).toBe(fileTabId);
    expect(collectTabIds(layout.root)).not.toContain("tab_new");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps a New tab's random identity when its launcher selects content", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {
        [workspaceKey]: normalizeLayout({
          root: createSidePanelRoot(
            createPane({ id: "main", tabIds: ["draft-1"] }),
            createPane({
              id: "side",
              tabIds: ["tab_new"],
              targetsByTabId: { tab_new: { kind: "new_tab" } },
            }),
          ),
          focusedPaneId: "side",
        }),
      },
    });

    const resultTabId = store.replaceTab(workspaceKey, "tab_new", { kind: "files" });

    expect(resultTabId).toBe("tab_new");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "side")?.tabIds).toEqual(["tab_new"]);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === "tab_new")?.target).toEqual({
      kind: "files",
    });
  });

  it("restores a layout saved with retired Explorer and PR bookkeeping keys", async () => {
    const savedLayout = {
      root: createSidePanelRoot(
        createPane({
          id: "main",
          tabIds: ["agent_agent-1"],
          targetsByTabId: { "agent_agent-1": { kind: "agent", agentId: "agent-1" } },
        }),
        createPane({
          id: "explorer",
          tabIds: ["files"],
          targetsByTabId: { files: { kind: "files" } },
        }),
      ),
      focusedPaneId: "main",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { renamed: savedLayout },
          explorerPaneIdByWorkspace: { renamed: "explorer" },
          acknowledgedPullRequestByWorkspace: { renamed: "url:https://example.test/pulls/1" },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace.renamed;
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["agent_agent-1"]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["files"]);
  });

  it("restores a layout persisted by the previous version with its side panel visibility", async () => {
    const workspaceKey = createWorkspaceKey();
    const savedLayout = {
      root: createSidePanelRoot(
        createPane({ id: "main", tabIds: ["draft-1"] }),
        createPane({
          id: "pane_saved",
          tabIds: ["file_/repo/worktree/a.ts"],
          targetsByTabId: {
            "file_/repo/worktree/a.ts": { kind: "file", path: "/repo/worktree/a.ts" },
          },
        }),
      ),
      focusedPaneId: "main",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { [workspaceKey]: savedLayout },
          splitSizesByWorkspace: { [workspaceKey]: { "group-root": [0.7, 0.3] } },
          sidePanelOpenByWorkspace: { [workspaceKey]: false },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const state = restored.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["draft-1"]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["file_/repo/worktree/a.ts"]);
    expect(state.splitSizesByWorkspace[workspaceKey]).toEqual({ "group-root": [0.7, 0.3] });
    expect(selectIsWorkspaceSidePanelOpen(state, workspaceKey)).toBe(false);
  });

  it("drops persisted New tabs on restore and returns parked focus to the main pane", async () => {
    const workspaceKey = createWorkspaceKey();
    const savedLayout = {
      root: createSidePanelRoot(
        createPane({ id: "main", tabIds: ["draft-1"] }),
        createPane({
          id: "pane_saved",
          tabIds: ["tab_new", "files"],
          focusedTabId: "tab_new",
          targetsByTabId: { tab_new: { kind: "new_tab" }, files: { kind: "files" } },
        }),
      ),
      focusedPaneId: null,
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: { layoutByWorkspace: { [workspaceKey]: savedLayout } },
        version: 2,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", "pane_saved"]);
    expect(getWorkspaceMainPane(layout.root).tabIds).toEqual(["draft-1"]);
    expect(getWorkspaceSidePane(layout.root)).toMatchObject({
      tabIds: ["files"],
      focusedTabId: "files",
    });
    expect(layout.focusedPaneId).toBe("main");
  });

  it("persists first-class pane targets, side panel visibility, and focus", async () => {
    await AsyncStorage.removeItem("workspace-layout-state");
    const workspaceKey = createWorkspaceKey();
    const source = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await source.persist.rehydrate();

    source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const focusedAgentTabId = source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-2" },
      intent: "reveal",
    });
    source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "files" }, intent: "reveal" });
    source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "pull_request" },
      intent: "background",
    });
    source.getState().setSidePanelOpen(workspaceKey, false);

    await vi.waitFor(async () => {
      expect(await AsyncStorage.getItem("workspace-layout-state")).not.toBeNull();
    });

    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    const state = restored.getState();
    const layout = state.layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(focusedAgentTabId);
    expect(collectAllTabs(layout.root).map((tab) => tab.target.kind)).toEqual([
      "agent",
      "agent",
      "files",
      "pull_request",
    ]);
    expect(selectIsWorkspaceSidePanelOpen(state, workspaceKey)).toBe(false);
  });

  it("persists and rehydrates independent Changes state through validated storage", async () => {
    await AsyncStorage.removeItem("workspace-layout-state");
    const workspaceKey = createWorkspaceKey();
    const source = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await source.persist.rehydrate();
    const first = source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "working_diff" }, intent: "new" })!;
    const second = source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "working_diff" }, intent: "new" })!;
    const firstState: ChangesState = {
      treeVisible: true,
      treeWidth: 320,
      collapsedFilePaths: ["src/a.ts"],
      collapsedFolderPaths: ["src"],
      commitsCollapsed: false,
    };
    const secondState: ChangesState = {
      treeVisible: false,
      collapsedFilePaths: ["README.md"],
      collapsedFolderPaths: ["docs"],
      commitsCollapsed: true,
    };
    source.getState().setTabState(workspaceKey, first, firstState);
    source.getState().setTabState(workspaceKey, second, secondState);

    await vi.waitFor(async () => {
      const persisted = await AsyncStorage.getItem("workspace-layout-state");
      expect(persisted).not.toBeNull();
      const root = JSON.parse(persisted ?? "{}").state.layoutByWorkspace[workspaceKey].root;
      expect(collectTabIds(root)).toEqual([first, second]);
    });

    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    const tabs = collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root);
    expect(tabs.find((tab) => tab.tabId === first)?.state).toEqual(firstState);
    expect(tabs.find((tab) => tab.tabId === second)?.state).toEqual(secondState);
  });

  it("restores workspace and agent plugin panel targets", async () => {
    const workspaceTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "summary",
      context: "workspace",
    };
    const agentTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            workspace: {
              root: {
                kind: "pane",
                pane: {
                  id: "main",
                  tabIds: ["workspace-panel", "agent-panel"],
                  focusedTabId: "agent-panel",
                  tabs: [
                    { tabId: "workspace-panel", target: workspaceTarget, createdAt: 1 },
                    { tabId: "agent-panel", target: agentTarget, createdAt: 2 },
                  ],
                },
              },
              focusedPaneId: "main",
            },
          },
          splitSizesByWorkspace: {},
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace.workspace;
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target)).toEqual([
      workspaceTarget,
      agentTarget,
    ]);
  });

  it("defers terminal reconciliation while a user terminal is being created", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownTerminalIds: ["terminal-1"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingTerminalCreate: true,
    });

    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, "terminal_terminal-1")).toBeNull();

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownTerminalIds: ["terminal-1"],
      standaloneTerminalIds: ["terminal-1"],
    });

    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["terminal_terminal-1"]);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps a tab where the user moved it when it is opened again", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    }) as string;
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const sidePaneId = getWorkspaceSidePane(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    )!.id;
    store.moveTabToPane(workspaceKey, agentTabId, sidePaneId);
    store.focusPane(workspaceKey, "main");

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, agentTabId)?.id).toBe(sidePaneId);
    expect(layout.focusedPaneId).toBe(sidePaneId);
  });

  it("an explicit pane-local open moves an existing tab into that pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const changesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
    });

    const reopened = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(reopened).toBe(changesTabId);
    expect(collectAllTabs(layout.root).filter((tab) => tab.tabId === changesTabId)).toHaveLength(1);
    expect(findPaneContainingTab(layout.root, changesTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(changesTabId);
    // The side pane lost its last tab to the main pane, so it collapses.
    expect(getWorkspaceSidePane(layout.root)).toBeNull();
  });

  it("a preferred open focuses an existing tab where the user left it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
    }) as string;
    const sidePaneId = getWorkspaceSidePane(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    )!.id;
    store.moveTabToPane(workspaceKey, fileTabId, "main");

    const reopened = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: sidePaneId },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(reopened).toBe(fileTabId);
    expect(findPaneContainingTab(layout.root, fileTabId)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
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

    const parentTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-parent" },
      intent: "reveal",
    });
    const childTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-child" },
      intent: "reveal",
      parentTabId: parentTabId!,
    });
    const rightTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-right" },
      intent: "reveal",
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

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
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

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
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

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
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

    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-2" },
      intent: "reveal",
    });
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

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
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
    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-2" },
      intent: "reveal",
    });
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

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
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
    store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "background",
    });
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      false,
    );

    // A focused open into it reveals it.
    store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-2" },
      intent: "reveal",
    });
    expect(selectIsWorkspaceSidePanelOpen(workspaceLayoutStore.getState(), workspaceKey)).toBe(
      true,
    );
  });

  it("focusTab moves workspace focus to the pane containing the tab", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const terminalTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
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

    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-2" },
      intent: "reveal",
    });

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

  it("replaceTab keeps a draft tab in place while updating its target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-retarget" },
      intent: "reveal",
    });
    const nextTabId = store.replaceTab(workspaceKey, draftTabId!, {
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

  it("replaceTab gives a non-draft tab the new target identity", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-retarget" },
      intent: "reveal",
    });
    const nextTabId = store.replaceTab(workspaceKey, agentTabId!, {
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

  it("replaceTab keeps a pane-local replacement beside an existing target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const existingFileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/existing.ts" },
      intent: "reveal",
    });
    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-dup" },
      intent: "reveal",
    });
    const secondDraftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-dup-2" },
      intent: "reveal",
    });

    const nextTabId = store.replaceTab(workspaceKey, secondDraftTabId!, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(existingFileTabId).toBe("file_/repo/worktree/existing.ts");
    expect(draftTabId).toBe("draft-dup");
    expect(nextTabId).toBe(secondDraftTabId);
    expect(findPaneContainingTab(layout.root, nextTabId!)?.id).toBe("main");
    expect(collectAllTabs(layout.root)).toHaveLength(3);
    expect(collectAllTabs(layout.root).filter((tab) => tab.target.kind === "file")).toHaveLength(2);
  });

  it("replaceTab keeps a pane-local replacement beside an existing matching target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstDraftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-agent-1" },
      intent: "reveal",
    });
    const firstAgentTabId = store.replaceTab(workspaceKey, firstDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const secondDraftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-agent-2" },
      intent: "reveal",
    });

    const nextTabId = store.replaceTab(workspaceKey, secondDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstAgentTabId).toBe(firstDraftTabId);
    expect(nextTabId).not.toBe(firstDraftTabId);
    expect(collectAllTabs(layout.root)).toHaveLength(2);
    expect(collectAllTabs(layout.root).filter((tab) => tab.target.kind === "agent")).toHaveLength(
      2,
    );
  });

  it("reorderTabs reorders tabs within the focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-a" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-b" },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-c" },
      intent: "reveal",
    });

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

    const thirdTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/c.ts" },
      intent: "reveal",
    });
    const fourthTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/d.ts" },
      intent: "reveal",
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

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
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

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
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

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
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
    const targets = [
      { kind: "file", path: "/repo/worktree/a.ts" },
      { kind: "terminal", terminalId: "term-1" },
      { kind: "browser", browserId: "browser-1" },
      { kind: "working_diff" },
      { kind: "changes" },
      { kind: "files" },
      { kind: "pull_request" },
    ] as const;

    for (const target of targets) {
      store.openTab({ workspaceKey, target, intent: "reveal" });
    }

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

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
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

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
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

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
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

    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const sidePaneId = "pane_abababab-abab-abab-abab-abababababab";

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe(sidePaneId);
    expect(collectTabIds(layout.root)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("persists working diff tabs while stripping commit diff tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey,
      target: { kind: "working_diff", focusPath: "src/a.ts" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "commit_diff", sha: "abc123" },
      intent: "reveal",
    });

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
      pinnedAgentIdsByWorkspace: {},
      splitSizesByWorkspace: currentState.splitSizesByWorkspace,
      sidePanelOpenByWorkspace: currentState.sidePanelOpenByWorkspace,
      pullRequestTabAutoOpenedByWorkspace: currentState.pullRequestTabAutoOpenedByWorkspace,
    });
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target)).toEqual([
      {
        kind: "working_diff",
        focusPath: "src/a.ts",
      },
    ]);
  });

  it("hydrates duplicate Changes and Pull request instances without collapsing their ids or state", () => {
    const tabs = [
      {
        tabId: "changes-a",
        createdAt: 1,
        target: { kind: "working_diff" },
        state: {
          mode: "base",
          baseRef: "main",
          layout: "split",
          wrapLines: true,
          hideWhitespace: true,
          treeVisible: true,
          treeWidth: 300,
          collapsedFilePaths: ["a"],
          collapsedFolderPaths: ["src"],
          commitsCollapsed: false,
        },
      },
      {
        tabId: "changes-b",
        createdAt: 2,
        target: { kind: "working_diff" },
        state: {
          mode: "uncommitted",
          layout: "unified",
          wrapLines: false,
          hideWhitespace: false,
          treeVisible: false,
          collapsedFilePaths: [],
          collapsedFolderPaths: [],
          commitsCollapsed: true,
        },
      },
      { tabId: "pr-a", createdAt: 3, target: { kind: "pull_request" } },
      { tabId: "pr-b", createdAt: 4, target: { kind: "pull_request" } },
    ];
    const layout = normalizeLayout({
      root: {
        kind: "pane",
        pane: { id: "main", tabIds: tabs.map((tab) => tab.tabId), focusedTabId: "changes-a", tabs },
      },
      focusedPaneId: "main",
    });
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "changes-a",
      "changes-b",
      "pr-a",
      "pr-b",
    ]);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === "changes-a")?.state,
    ).toMatchObject({ baseRef: "main", treeWidth: 300, collapsedFolderPaths: ["src"] });
  });

  it("resizeSplit keeps sizes normalized while enforcing the minimum proportion", () => {
    useWorkspaceLayoutIds("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });

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

    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    store.closeTab(workspaceKey, tabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout).toEqual(createDefaultLayout());
  });

  it("persists explicit agent opens per workspace", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    store.openTab({
      workspaceKey: otherWorkspaceKey as string,
      target: { kind: "agent", agentId: "agent-2" },
      intent: "reveal",
      pin: true,
    });

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
    expect(partialize?.(state)).toHaveProperty("pinnedAgentIdsByWorkspace", {
      [otherWorkspaceKey as string]: ["agent-2"],
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
      pinnedAgentIdsByWorkspace: {},
      splitSizesByWorkspace: {},
      sidePanelOpenByWorkspace: {},
      pullRequestTabAutoOpenedByWorkspace: {},
    });
  });

  it("convertDraftToAgent removes the draft and focuses the existing canonical agent tab", () => {
    useWorkspaceLayoutIds("67676767-6767-6767-6767-676767676767");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-existing" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusTab(workspaceKey, draftTabId!);

    const nextTabId = store.convertDraftToAgent(workspaceKey, draftTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(nextTabId).toBe("agent_agent-1");
    expect(collectTabIds(layout.root)).toEqual(["agent_agent-1"]);
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
      standaloneTerminalIds: ["term-1"],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabs = collectAllTabs(layout.root);

    // The auto-opened terminal is a side panel tab, so it opens beside the chats.
    expect(tabs.map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
      "draft-1",
      "agent_agent-2",
      "terminal_term-1",
    ]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual(["terminal_term-1"]);
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
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);
  });

  it("reconcileTabs focuses the first auto-opened agent in an empty workspace", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["agent_agent-1"]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs leaves an empty hydrated workspace on its empty main pane, once", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const snapshot = {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    };

    store.reconcileTabs(workspaceKey, snapshot);

    const initialized = workspaceLayoutStore.getState();
    expect(initialized.layoutByWorkspace[workspaceKey]).toEqual(createDefaultLayout());

    store.reconcileTabs(workspaceKey, snapshot);

    expect(workspaceLayoutStore.getState()).toBe(initialized);
  });

  it("reconcileTabs does not auto-open subagents omitted from autoOpenAgentIds", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
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

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
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

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent"],
      autoOpenAgentIds: ["parent-agent"],
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

  it("openTab reveal intent reopens hidden subagent tabs and clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "child-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["child-agent"],
      autoOpenAgentIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_child-agent",
    ]);
  });

  it("reconcileTabs auto-opens only standalone terminals while keeping explicitly opened live terminals", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const scriptTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-script" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
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
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
  });

  it("opening a pinned agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    expect(workspaceLayoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey]).toBeDefined();

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
  });

  it("keeps an explicitly opened agent when its detail leaves client memory", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const emptySnapshot = {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      standaloneTerminalIds: [],
    };
    const agentTabIds = () =>
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId);

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, emptySnapshot);
    expect(agentTabIds()).toEqual(["agent_archived-agent"]);

    store.reconcileTabs(workspaceKey, emptySnapshot);
    expect(agentTabIds()).toEqual(["agent_archived-agent"]);

    store.reconcileTabs(workspaceKey, emptySnapshot);
    expect(agentTabIds()).toEqual(["agent_archived-agent"]);

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, emptySnapshot);
    expect(agentTabIds()).toEqual(["agent_archived-agent"]);
  });

  it("restores the selected historical agent before any server data or cache is available", async () => {
    const workspaceKey = createWorkspaceKey();
    workspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    restored.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      standaloneTerminalIds: [],
    });
    const layout = restored.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(
      "agent_archived-agent",
    );
  });

  it("follows server archive after an explicitly opened agent becomes active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      standaloneTerminalIds: [],
    });
    expect(store.getWorkspaceTabs(workspaceKey).some((tab) => tab.target.kind === "agent")).toBe(
      false,
    );
  });

  it("atomically reveals, focuses, and pins an archived agent against reconciliation", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "first-agent" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "second-agent" },
      intent: "reveal",
    });
    store.hideAgent(workspaceKey, "archived-agent");

    const archivedTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["first-agent", "second-agent"],
      autoOpenAgentIds: ["first-agent", "second-agent"],
      standaloneTerminalIds: [],
    });

    const state = workspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toContain(archivedTabId);
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(archivedTabId);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toContain(
      "archived-agent",
    );
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("retargeting a tab to an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.replaceTab(workspaceKey, tabId!, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("closePane empties the side pane and leaves it on its launcher", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    const sidePaneId = getWorkspaceSidePane(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    )!.id;

    store.closePane(workspaceKey, sidePaneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", sidePaneId]);
    expect(getWorkspaceSidePane(layout.root)?.tabIds).toEqual([]);
    expect(collectTabIds(layout.root)).toEqual([agentTabId]);
  });

  it("closePane refuses to close the last visible pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBe(before);
  });

  it("closePane never closes the chat's pane beside the side panel", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const sidePaneId = getWorkspaceSidePane(before.root)!.id;

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", sidePaneId]);
  });

  it("canDismissPaneInLayout only dismisses a side pane that holds tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const mainOnly = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(canDismissPaneInLayout(mainOnly, "main")).toBe(false);

    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    }) as string;
    const withSidePane = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const sidePaneId = getWorkspaceSidePane(withSidePane.root)!.id;
    expect(canDismissPaneInLayout(withSidePane, "main")).toBe(false);
    expect(canDismissPaneInLayout(withSidePane, sidePaneId)).toBe(true);

    store.closeTab(workspaceKey, fileTabId);
    const emptiedSidePane = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(canDismissPaneInLayout(emptiedSidePane, sidePaneId)).toBe(false);
  });

  it("closePane on a loaded final pane keeps the pane and every tab in it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });
});

it("persists the once-only PR add after closing, and clears it when purging the workspace", async () => {
  await AsyncStorage.removeItem("workspace-layout-state");
  const source = createWorkspaceLayoutStore(workspaceLayoutIds);
  await source.persist.rehydrate();
  const workspaceKey = "server-1:pr-once";
  const placement = () => ({});
  source.getState().autoOpenPullRequestTab(workspaceKey, placement);
  source.getState().closeTab(workspaceKey, "pull_request");
  const restored = createWorkspaceLayoutStore(workspaceLayoutIds);
  await restored.persist.rehydrate();
  expect(restored.getState().pullRequestTabAutoOpenedByWorkspace[workspaceKey]).toBe(true);
  expect(restored.getState().autoOpenPullRequestTab(workspaceKey, placement)).toBeNull();
  expect(
    collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root).map(
      (tab) => tab.target.kind,
    ),
  ).not.toContain("pull_request");
  restored.getState().purgeWorkspace(workspaceKey);
  expect(restored.getState().pullRequestTabAutoOpenedByWorkspace[workspaceKey]).toBeUndefined();
  expect(restored.getState().autoOpenPullRequestTab(workspaceKey, placement)).toBe("pull_request");
});

describe("compact workspace sheet", () => {
  const workspaceKey = "server-1:sheet-ws";
  const fileTarget = { kind: "file" as const, path: "src/index.ts" };

  function createCompactStore() {
    const store = createWorkspaceLayoutStore(workspaceLayoutIds);
    store.setState({ layoutByWorkspace: {}, sheetsByWorkspace: {} });
    store.getState().setLayoutMode("compact");
    store.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    return store;
  }

  function topSheet(store: ReturnType<typeof createCompactStore>) {
    return store.getState().sheetsByWorkspace[workspaceKey]?.at(-1);
  }

  function sheetTargets(store: ReturnType<typeof createCompactStore>) {
    return (store.getState().sheetsByWorkspace[workspaceKey] ?? []).map(
      (sheet) => sheet.tab.target,
    );
  }

  // Tab kinds in layout order: the chats in the main pane, then the side panel's tabs.
  function tabKinds(store: ReturnType<typeof createCompactStore>): string[] {
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    return collectAllTabs(layout.root).map((tab) => tab.target.kind);
  }

  function sidePane(store: ReturnType<typeof createCompactStore>) {
    return getWorkspaceSidePane(store.getState().layoutByWorkspace[workspaceKey].root);
  }

  function seedAgents(agents: Array<Pick<Agent, "id" | "parentAgentId" | "workspaceId">>): void {
    const timestamp = new Date("2026-04-21T10:00:00.000Z");
    useSessionStore.getState().initializeSession("server-1", null as unknown as DaemonClient);
    useSessionStore.getState().setAgents(
      "server-1",
      new Map(
        agents.map((agent) => [
          agent.id,
          {
            serverId: "server-1",
            provider: "codex",
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
            createdAt: timestamp,
            updatedAt: timestamp,
            lastUserMessageAt: null,
            lastActivityAt: timestamp,
            capabilities: {
              supportsStreaming: true,
              supportsSessionPersistence: true,
              supportsDynamicModes: true,
              supportsMcpServers: true,
              supportsReasoningStream: true,
              supportsToolInvocations: true,
            },
            currentModeId: null,
            availableModes: [],
            pendingPermissions: [],
            persistence: null,
            runtimeInfo: undefined,
            lastUsage: undefined,
            lastError: null,
            title: agent.id,
            cwd: "/repo",
            model: null,
            features: undefined,
            thinkingOptionId: undefined,
            requiresAttention: false,
            attentionReason: null,
            attentionTimestamp: null,
            archivedAt: null,
            labels: {},
            projectPlacement: null,
            ...agent,
          } satisfies Agent,
        ]),
      ),
    );
  }

  it("reveals a file in the sheet and leaves the tab strip unchanged", () => {
    const store = createCompactStore();
    const before = tabKinds(store);

    const tabId = store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    expect(topSheet(store)?.tab).toEqual({
      tabId,
      target: fileTarget,
      createdAt: expect.any(Number),
    });
    expect(tabKinds(store)).toEqual(before);
  });

  it("focuses a target that is already open as a tab instead of using the sheet", () => {
    const store = createCompactStore();
    store.getState().setLayoutMode("split-panes");
    const fileTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    store.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    store.getState().setLayoutMode("compact");

    const tabId = store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    expect(tabId).toBe(fileTabId);
    expect(topSheet(store)).toBeUndefined();
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, fileTabId ?? "")?.focusedTabId).toBe(fileTabId);
  });

  it("stacks the next sheet target over the open sheet", () => {
    const store = createCompactStore();
    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    const nextTarget = { kind: "file" as const, path: "src/other.ts" };
    const nextTabId = store
      .getState()
      .openTab({ workspaceKey, target: nextTarget, intent: "reveal" });

    expect(sheetTargets(store)).toEqual([fileTarget, nextTarget]);
    expect(tabKinds(store)).toEqual(["terminal"]);

    store.getState().closeTab(workspaceKey, nextTabId ?? "");
    expect(sheetTargets(store)).toEqual([fileTarget]);
  });

  it("closes a lower sheet and keeps the sheets above it", () => {
    const store = createCompactStore();
    const fileTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    const nextTarget = { kind: "file" as const, path: "src/other.ts" };
    store.getState().openTab({ workspaceKey, target: nextTarget, intent: "reveal" });

    store.getState().closeTab(workspaceKey, fileTabId ?? "");

    expect(sheetTargets(store)).toEqual([nextTarget]);
    expect(tabKinds(store)).toEqual(["terminal"]);
  });

  it("uncovers a covered sheet by dropping the sheets above it", () => {
    const store = createCompactStore();
    const fileTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    store
      .getState()
      .openTab({ workspaceKey, target: { kind: "file", path: "src/other.ts" }, intent: "reveal" });

    const tabId = store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    expect(tabId).toBe(fileTabId);
    expect(sheetTargets(store)).toEqual([fileTarget]);
  });

  it("opens the top sheet as a tab and dismisses the sheets that would cover it", () => {
    const store = createCompactStore();
    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    const nextTabId = store
      .getState()
      .openTab({ workspaceKey, target: { kind: "file", path: "src/other.ts" }, intent: "reveal" });

    store.getState().openSheetAsTab(workspaceKey, nextTabId ?? "");

    expect(sheetTargets(store)).toEqual([]);
    expect(tabKinds(store)).toEqual(["terminal", "file"]);
    expect(sidePane(store)?.focusedTabId).toBe(nextTabId);
  });

  it("closes the sheet when a tab target is revealed, and keeps it for background opens", () => {
    const store = createCompactStore();
    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    store.getState().openTab({
      workspaceKey,
      target: { kind: "file", path: "src/background.ts" },
      intent: "background",
    });
    expect(topSheet(store)?.tab.target).toEqual(fileTarget);
    expect(tabKinds(store)).toEqual(["terminal", "file"]);

    store.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-2" },
      intent: "reveal",
    });
    expect(topSheet(store)).toBeUndefined();
  });

  it("moves the sheet tab into its pane with the same tab id and state", () => {
    const store = createCompactStore();
    const sheetTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    if (!sheetTabId) throw new Error("Expected a sheet tab");
    store.getState().setTabState(workspaceKey, sheetTabId, { scrollTop: 120 });

    const tabId = store.getState().openSheetAsTab(workspaceKey, sheetTabId);

    expect(tabId).toBe(sheetTabId);
    expect(topSheet(store)).toBeUndefined();
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneContainingTab(layout.root, sheetTabId);
    expect(pane?.id).toBe(layout.focusedPaneId);
    expect(pane?.focusedTabId).toBe(sheetTabId);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === sheetTabId)?.state).toEqual({
      scrollTop: 120,
    });
  });

  it("closes the sheet through the ordinary close and ignores focus requests for it", () => {
    const store = createCompactStore();
    const sheetTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    if (!sheetTabId) throw new Error("Expected a sheet tab");
    const layoutBefore = store.getState().layoutByWorkspace[workspaceKey];

    store.getState().focusTab(workspaceKey, sheetTabId);
    expect(store.getState().layoutByWorkspace[workspaceKey]).toBe(layoutBefore);

    store.getState().closeTab(workspaceKey, sheetTabId);
    expect(topSheet(store)).toBeUndefined();
    expect(tabKinds(store)).toEqual(["terminal"]);
  });

  it("suspends pane focus while the sheet covers the panes", () => {
    const store = createCompactStore();
    expect(selectPaneFocusSuspended(store.getState(), workspaceKey)).toBe(false);

    const sheetTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    expect(selectPaneFocusSuspended(store.getState(), workspaceKey)).toBe(true);

    store.getState().closeTab(workspaceKey, sheetTabId ?? "");
    expect(selectPaneFocusSuspended(store.getState(), workspaceKey)).toBe(false);
  });

  it("never uses the sheet on wide layouts", () => {
    const store = createCompactStore();
    store.getState().setLayoutMode("split-panes");

    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    expect(store.getState().sheetsByWorkspace).toEqual({});
    expect(tabKinds(store)).toEqual(["terminal", "file"]);
  });

  it("keeps every stacked sheet as a tab when the layout widens, focusing the top one", () => {
    const store = createCompactStore();
    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    const sheetTabId = store
      .getState()
      .openTab({ workspaceKey, target: { kind: "file", path: "src/other.ts" }, intent: "reveal" });

    store.getState().setLayoutMode("split-panes");

    expect(store.getState().sheetsByWorkspace).toEqual({});
    expect(tabKinds(store)).toEqual(["terminal", "file", "file"]);
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, sheetTabId ?? "")?.focusedTabId).toBe(sheetTabId);
  });

  it("opens subagents and provider subagents in the sheet but keeps root agents as tabs", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
      { id: "other-workspace-child", parentAgentId: "root", workspaceId: "other-ws" },
    ]);
    const store = createCompactStore();

    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
    });
    expect(topSheet(store)).toMatchObject({
      tab: { target: { kind: "agent", agentId: "child" } },
      policy: { openAsTab: true },
    });

    store.getState().openTab({
      workspaceKey,
      target: { kind: "provider_subagent", parentAgentId: "root", subagentId: "task-1" },
      intent: "reveal",
    });
    expect(topSheet(store)).toMatchObject({
      tab: { target: { kind: "provider_subagent", subagentId: "task-1" } },
      policy: { openAsTab: false },
    });

    for (const agentId of ["root", "other-workspace-child"]) {
      store
        .getState()
        .openTab({ workspaceKey, target: { kind: "agent", agentId }, intent: "reveal" });
    }
    expect(topSheet(store)).toBeUndefined();
    expect(tabKinds(store)).toEqual(["agent", "agent", "terminal"]);
  });

  it("gives a sheet target opened from inside the sheet the sheet's own parent", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    const rootTabId = store
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId: "root" }, intent: "reveal" });
    const childSheetTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
      parentTabId: rootTabId ?? undefined,
    });

    const fileSheetTabId = store.getState().openTab({
      workspaceKey,
      target: fileTarget,
      intent: "reveal",
      parentTabId: childSheetTabId ?? undefined,
    });
    expect(topSheet(store)?.parentTabId).toBe(rootTabId);

    store.getState().openSheetAsTab(workspaceKey, fileSheetTabId ?? "");
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(layout.parentTabIdByTabId?.[fileSheetTabId ?? ""]).toBe(rootTabId);
  });

  it("closes the sheet and reveals the tab when a tab target is opened from inside the sheet", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
      { id: "second-root", parentAgentId: null, workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    const rootTabId = store
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId: "root" }, intent: "reveal" });
    const openChildSheet = () =>
      store.getState().openTab({
        workspaceKey,
        target: { kind: "agent", agentId: "child" },
        intent: "reveal",
        parentTabId: rootTabId ?? undefined,
      }) ?? undefined;

    const terminalTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
      parentTabId: openChildSheet(),
    });
    expect(topSheet(store)).toBeUndefined();
    let layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(terminalTabId);

    const secondRootTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "second-root" },
      intent: "reveal",
      parentTabId: openChildSheet(),
    });
    expect(topSheet(store)).toBeUndefined();
    layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(secondRootTabId);
    expect(layout.parentTabIdByTabId?.[secondRootTabId ?? ""]).toBe(rootTabId);
    expect(tabKinds(store)).toEqual(["agent", "agent", "terminal"]);
  });

  describe("unsaved sheet work", () => {
    const sheetPanel = (tabId: string) => ({
      serverId: "server-1",
      workspaceId: "sheet-ws",
      tabId,
    });
    let modifiedTabId: string | null = null;

    function openModifiedFileSheet(store: ReturnType<typeof createCompactStore>): string {
      const tabId = store
        .getState()
        .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
      if (!tabId) throw new Error("Expected a sheet tab");
      store.getState().setTabState(workspaceKey, tabId, { scrollTop: 40 });
      setPanelInstanceAttributes(sheetPanel(tabId), { modified: true });
      modifiedTabId = tabId;
      return tabId;
    }

    function stripTab(store: ReturnType<typeof createCompactStore>, tabId: string) {
      const layout = store.getState().layoutByWorkspace[workspaceKey];
      return collectAllTabs(layout.root).find((tab) => tab.tabId === tabId) ?? null;
    }

    function focusedTabId(store: ReturnType<typeof createCompactStore>): string | null {
      const layout = store.getState().layoutByWorkspace[workspaceKey];
      return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
    }

    afterEach(() => {
      if (modifiedTabId) setPanelInstanceAttributes(sheetPanel(modifiedTabId), { modified: false });
      modifiedTabId = null;
    });

    function sheetTabId(store: ReturnType<typeof createCompactStore>): string | null {
      return topSheet(store)?.tab.tabId ?? null;
    }

    it("stacks the next sheet target over a modified sheet", () => {
      const store = createCompactStore();
      openModifiedFileSheet(store);

      const nextTarget = { kind: "file" as const, path: "src/other.ts" };
      const nextTabId = store
        .getState()
        .openTab({ workspaceKey, target: nextTarget, intent: "reveal" });

      expect(sheetTabId(store)).toBe(nextTabId);
      expect(sheetTargets(store)).toEqual([fileTarget, nextTarget]);
      expect(store.getState().sheetsByWorkspace[workspaceKey]?.[0]?.tab.state).toEqual({
        scrollTop: 40,
      });
    });

    it("keeps a covered sheet in place under a modified sheet instead of reordering", () => {
      const store = createCompactStore();
      const otherTarget = { kind: "file" as const, path: "src/other.ts" };
      const otherTabId = store
        .getState()
        .openTab({ workspaceKey, target: otherTarget, intent: "reveal" });
      const modifiedSheetTabId = openModifiedFileSheet(store);
      const unmodifiedTopTarget = { kind: "file" as const, path: "src/third.ts" };
      store.getState().openTab({ workspaceKey, target: unmodifiedTopTarget, intent: "reveal" });
      const focusedBefore = focusedTabId(store);

      const tabId = store
        .getState()
        .openTab({ workspaceKey, target: otherTarget, intent: "reveal" });

      expect(tabId).toBe(otherTabId);
      // Moving a sheet would remount its panel, so the stack keeps its order: the modified sheet
      // stays on top of the one revealed, and only the unmodified sheet above them closes.
      expect(sheetTargets(store)).toEqual([otherTarget, fileTarget]);
      expect(sheetTabId(store)).toBe(modifiedSheetTabId);
      expect(stripTab(store, tabId ?? "")).toBeNull();
      expect(focusedTabId(store)).toBe(focusedBefore);
    });

    it("opens a tab target under a modified sheet without closing it", () => {
      const store = createCompactStore();
      const modifiedSheetTabId = openModifiedFileSheet(store);

      const terminalTabId = store.getState().openTab({
        workspaceKey,
        target: { kind: "terminal", terminalId: "term-2" },
        intent: "reveal",
      });

      expect(sheetTabId(store)).toBe(modifiedSheetTabId);
      expect(focusedTabId(store)).toBe(terminalTabId);
    });

    it("keeps a modified sheet open when another tab is chosen", () => {
      const store = createCompactStore();
      const secondTabId = store.getState().openTab({
        workspaceKey,
        target: { kind: "terminal", terminalId: "term-2" },
        intent: "reveal",
      });
      const firstTabId = store.getState().getWorkspaceTabs(workspaceKey)[0]?.tabId ?? "";
      const modifiedSheetTabId = openModifiedFileSheet(store);

      store.getState().focusTab(workspaceKey, firstTabId);
      expect(sheetTabId(store)).toBe(modifiedSheetTabId);
      expect(focusedTabId(store)).toBe(firstTabId);

      store.getState().selectTabInPane(workspaceKey, sidePane(store)!.id, secondTabId ?? "");
      expect(sheetTabId(store)).toBe(modifiedSheetTabId);
      expect(focusedTabId(store)).toBe(secondTabId);

      store.getState().closeTab(workspaceKey, modifiedSheetTabId);
      expect(sheetTabId(store)).toBeNull();
      expect(tabKinds(store)).toEqual(["terminal", "terminal"]);
    });

    it("closes an unmodified sheet when another tab is chosen", () => {
      const store = createCompactStore();
      const secondTabId = store.getState().openTab({
        workspaceKey,
        target: { kind: "terminal", terminalId: "term-2" },
        intent: "reveal",
      });
      const firstTabId = store.getState().getWorkspaceTabs(workspaceKey)[0]?.tabId ?? "";

      store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
      store.getState().focusTab(workspaceKey, firstTabId);
      expect(sheetTabId(store)).toBeNull();
      expect(focusedTabId(store)).toBe(firstTabId);

      store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
      store.getState().selectTabInPane(workspaceKey, sidePane(store)!.id, secondTabId ?? "");
      expect(sheetTabId(store)).toBeNull();
      expect(focusedTabId(store)).toBe(secondTabId);
      expect(tabKinds(store)).toEqual(["terminal", "terminal"]);
    });
  });

  it("closes the sheet when its agent leaves the workspace", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
    });
    const snapshot = {
      terminalsHydrated: false,
      activeAgentIds: ["root"],
      autoOpenAgentIds: [],
      knownTerminalIds: ["term-1"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingTerminalCreate: false,
    };

    store.getState().reconcileTabs(workspaceKey, { ...snapshot, agentsHydrated: false });
    expect(topSheet(store)).toBeDefined();

    store.getState().reconcileTabs(workspaceKey, { ...snapshot, agentsHydrated: true });
    expect(topSheet(store)).toBeUndefined();
  });

  it("drops a departed agent's sheet from the middle of the stack", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    const nextTarget = { kind: "file" as const, path: "src/other.ts" };
    store.getState().openTab({ workspaceKey, target: fileTarget, intent: "reveal" });
    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
    });
    store.getState().openTab({ workspaceKey, target: nextTarget, intent: "reveal" });

    store.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: false,
      activeAgentIds: ["root"],
      autoOpenAgentIds: [],
      knownTerminalIds: ["term-1"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingTerminalCreate: false,
    });

    expect(sheetTargets(store)).toEqual([fileTarget, nextTarget]);
  });

  it("closes the sheet when its agent stops being a subagent, leaving one tab for it", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    const sheetTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
    });
    const snapshot = {
      agentsHydrated: true,
      terminalsHydrated: false,
      activeAgentIds: ["root", "child"],
      autoOpenAgentIds: ["child"],
      knownTerminalIds: ["term-1"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingTerminalCreate: false,
    };

    store.getState().reconcileTabs(workspaceKey, { ...snapshot, autoOpenAgentIds: [] });
    expect(topSheet(store)?.tab.tabId).toBe(sheetTabId);

    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: null, workspaceId: "sheet-ws" },
    ]);
    store.getState().reconcileTabs(workspaceKey, snapshot);

    expect(topSheet(store)).toBeUndefined();
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    expect(
      collectAllTabs(layout.root).filter(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === "child",
      ),
    ).toHaveLength(1);
  });

  it("re-resolves the sheet policy when the sheet tab gets another target", () => {
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const store = createCompactStore();
    const sheetTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "provider_subagent", parentAgentId: "root", subagentId: "task-1" },
      intent: "reveal",
    });

    const replacedTabId = store
      .getState()
      .replaceTab(workspaceKey, sheetTabId ?? "", { kind: "agent", agentId: "child" });

    expect(replacedTabId).toBe(sheetTabId);
    expect(topSheet(store)).toMatchObject({
      tab: { tabId: sheetTabId, target: { kind: "agent", agentId: "child" } },
      policy: { openAsTab: true },
    });
  });

  it("moves the sheet tab into the tab strip when it gets a target the sheet does not host", () => {
    const store = createCompactStore();
    const sheetTabId = store
      .getState()
      .openTab({ workspaceKey, target: fileTarget, intent: "reveal" });

    const replacedTabId = store.getState().replaceTab(workspaceKey, sheetTabId ?? "", {
      kind: "terminal",
      terminalId: "term-2",
    });

    expect(topSheet(store)).toBeUndefined();
    expect(replacedTabId).toBe(sheetTabId);
    expect(sidePane(store)?.focusedTabId).toBe(sheetTabId);
    expect(tabKinds(store)).toEqual(["terminal", "terminal"]);
  });

  it("honors an explicit pane destination on compact layouts", () => {
    const store = createCompactStore();
    const paneId = sidePane(store)!.id;
    const tabId = store.getState().openTab({
      workspaceKey,
      target: fileTarget,
      intent: "new",
      placement: { mode: "pane", paneId },
    });
    expect(topSheet(store)).toBeUndefined();
    expect(
      findPaneById(store.getState().layoutByWorkspace[workspaceKey].root, paneId)?.focusedTabId,
    ).toBe(tabId);
  });

  it("keeps a chat shown in the sheet open for timeline sync until the sheet closes", () => {
    const store = createCompactStore();
    seedAgents([
      { id: "root", parentAgentId: null, workspaceId: "sheet-ws" },
      { id: "child", parentAgentId: "root", workspaceId: "sheet-ws" },
    ]);
    const received: string[][] = [];
    const stop = observeOpenWorkspaceAgentIds("server-1", (ids) => received.push(ids), store);

    const sheetTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "child" },
      intent: "reveal",
    });
    store.getState().closeTab(workspaceKey, sheetTabId ?? "");
    stop();

    expect(received).toEqual([[], ["child"], []]);
  });
});

describe("pending workspace opens", () => {
  it("retains an open across hydration and consumes it once only for its workspace", async () => {
    const values = new Map<string, string>();
    const store = createWorkspaceLayoutStore(undefined, {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    });
    store.getState().deferOpenTab({
      workspaceKey: "server:beta",
      target: { kind: "agent", agentId: "b" },
      intent: "reveal",
      pin: true,
    });
    await store.persist.rehydrate();
    expect(store.getState().consumePendingOpen("server:alpha")).toBeNull();
    expect(
      store
        .getState()
        .getWorkspaceTabs("server:alpha")
        .filter((tab) => tab.target.kind === "agent"),
    ).toEqual([]);
    expect(store.getState().consumePendingOpen("server:beta")).toBe("agent_b");
    expect(store.getState().consumePendingOpen("server:beta")).toBeNull();
    expect(
      store
        .getState()
        .getWorkspaceTabs("server:beta")
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.target),
    ).toEqual([{ kind: "agent", agentId: "b" }]);
    expect(store.getState().pinnedAgentIdsByWorkspace["server:beta"]).toEqual(new Set(["b"]));
    expect(store.getState().pendingOpenByWorkspace).toEqual({});
  });
});
