import type { FeedbackContextTarget } from "@getpaseo/protocol/feedback/schemas";
import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export function resolveCurrentFeedbackChat(input: {
  pathname: string;
  layouts: Readonly<Record<string, WorkspaceLayout>>;
}): FeedbackContextTarget | null {
  const route = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (!route) return null;
  const workspaceKey = buildWorkspaceTabPersistenceKey(route);
  const layout = workspaceKey ? input.layouts[workspaceKey] : null;
  if (!layout) return null;
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  if (!focusedPane?.focusedTabId) return null;
  const focusedTab = collectAllTabs(layout.root).find(
    (tab) => tab.tabId === focusedPane.focusedTabId,
  );
  if (focusedTab?.target.kind !== "agent") return null;
  return { agentId: focusedTab.target.agentId, workspaceId: route.workspaceId };
}
