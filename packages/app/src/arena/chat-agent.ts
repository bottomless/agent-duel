import {
  collectAllTabs,
  getWorkspaceMainPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

/**
 * The workspace's chat, which is the battle the side panel reports on.
 *
 * It is read from the main pane rather than from whatever holds focus: the panels
 * that ask for it are themselves focusable, so a focused-tab rule would go blank
 * the moment one of them is opened. The main pane holds one chat per workspace
 * ([side panel](../../../../docs/side-panel.md)), so there is nothing else to
 * disambiguate; a tab dragged onto it takes focus without displacing that chat.
 */
export function resolveWorkspaceChatAgentId(layout: WorkspaceLayout | undefined): string | null {
  if (!layout) {
    return null;
  }
  const mainPane = getWorkspaceMainPane(layout.root);
  const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const mainTabs = mainPane.tabIds.flatMap((tabId): WorkspaceTab[] => {
    const tab = tabsById.get(tabId);
    return tab ? [tab] : [];
  });
  const focused = mainTabs.find((tab) => tab.tabId === mainPane.focusedTabId);
  const chat =
    focused?.target.kind === "agent"
      ? focused
      : mainTabs.find((tab) => tab.target.kind === "agent");
  return chat?.target.kind === "agent" ? chat.target.agentId : null;
}
