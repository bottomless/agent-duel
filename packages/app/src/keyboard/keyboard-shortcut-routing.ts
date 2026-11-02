import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import type { WorkspaceRouteState } from "@/screens/workspace/workspace-route-state";

export function canUseWorkspaceLayoutShortcuts(
  isRouteFocused: boolean,
  state: WorkspaceRouteState,
): boolean {
  return isRouteFocused && state.kind === "ready";
}

export function canToggleFileExplorerShortcut(input: {
  selectedAgentId?: string;
  pathname: string;
  toggleFileExplorer?: () => void;
}): boolean {
  if (!input.toggleFileExplorer) {
    return false;
  }
  if (parseHostWorkspaceRouteFromPathname(input.pathname)) {
    return true;
  }

  if (parseHostAgentRouteFromPathname(input.pathname)) {
    return true;
  }

  return false;
}
