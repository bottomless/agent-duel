import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * Opens (or focuses) a side panel tab for a workspace from outside the
 * workspace screen: a chat's review attachment, a tool call's directory, a
 * terminal's file button. The layout store routes the tab into the side pane
 * and reveals the panel; on compact widths the tab simply joins the tab list,
 * so the content drawer is brought back on top of any open sidebar.
 */
export function openWorkspaceSidePanelTab(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  target: WorkspaceTabTarget;
}): string | null {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    return null;
  }
  const persistenceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId,
  });
  if (!persistenceKey) {
    return null;
  }
  usePanelStore.getState().showMobileAgent();
  return useWorkspaceLayoutStore.getState().openTabFocused(persistenceKey, input.target);
}
