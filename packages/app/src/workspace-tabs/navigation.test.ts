import { beforeEach, expect, it } from "vitest";
import {
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "./navigation";

const workspaceKey = "server:workspace";
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    sidePanelOpenByWorkspace: {},
  });
  usePanelStore.getState().showMobileAgent();
});

function openRevealed(target: WorkspaceTabTarget) {
  return revealWorkspaceTab(
    workspaceKey,
    useWorkspaceLayoutStore.getState().openTab({ workspaceKey, target, intent: "reveal" }),
  );
}

it("reveals an existing side panel file from the compact agent list", () => {
  const store = useWorkspaceLayoutStore.getState();
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "file", path: "existing.ts" },
    intent: "reveal",
  });
  store.setSidePanelOpen(workspaceKey, false);
  store.setLayoutMode("compact");
  usePanelStore.getState().showMobileAgentList();

  expect(openRevealed({ kind: "file", path: "existing.ts" })).toBe(tabId);

  const state = useWorkspaceLayoutStore.getState();
  expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  expect(selectIsWorkspaceSidePanelOpen(state, workspaceKey)).toBe(true);
  expect(state.getTabDestination(workspaceKey, tabId!)).toMatchObject({ host: "side" });
});

it("keeps the agent list beneath a new compact file sheet", () => {
  useWorkspaceLayoutStore.getState().setLayoutMode("compact");
  usePanelStore.getState().showMobileAgentList();

  const tabId = openRevealed({ kind: "file", path: "new.ts" });

  expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]?.[0].tab.tabId).toBe(
    tabId,
  );
});

it("reopens a hidden side panel and preserves the surface after a failed open", () => {
  const store = useWorkspaceLayoutStore.getState();
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "terminal", terminalId: "terminal-1" },
    intent: "reveal",
  });
  store.setSidePanelOpen(workspaceKey, false);

  revealWorkspaceTab(workspaceKey, tabId);
  expect(selectIsWorkspaceSidePanelOpen(useWorkspaceLayoutStore.getState(), workspaceKey)).toBe(
    true,
  );

  store.setSidePanelOpen(workspaceKey, false);
  usePanelStore.getState().showMobileAgentList();
  expect(revealWorkspaceTab(workspaceKey, null)).toBeNull();
  expect(revealWorkspaceTab(workspaceKey, "missing")).toBeNull();
  expect(selectIsWorkspaceSidePanelOpen(useWorkspaceLayoutStore.getState(), workspaceKey)).toBe(
    false,
  );
  expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
});

it("reveals a chat in the main pane without opening the side panel", () => {
  const tabId = openRevealed({ kind: "agent", agentId: "root" });

  const state = useWorkspaceLayoutStore.getState();
  expect(state.getTabDestination(workspaceKey, tabId!)).toMatchObject({ host: "main" });
  expect(selectIsWorkspaceSidePanelOpen(state, workspaceKey)).toBe(false);
});

it.each(["agent", "agent-list"] as const)(
  "preserves %s under a deferred file sheet and reveals deferred agents",
  (panel) => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("compact");
    if (panel === "agent-list") usePanelStore.getState().showMobileAgentList();
    const before = usePanelStore.getState().mobilePanel;
    store.deferOpenTab({
      workspaceKey,
      target: { kind: "file", path: "pending.ts" },
      intent: "reveal",
    });
    revealWorkspaceTab(workspaceKey, store.consumePendingOpen(workspaceKey));
    expect(usePanelStore.getState().mobilePanel).toEqual(before);
    store.deferOpenTab({
      workspaceKey,
      target: { kind: "agent", agentId: "root" },
      intent: "reveal",
    });
    revealWorkspaceTab(workspaceKey, store.consumePendingOpen(workspaceKey));
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  },
);
