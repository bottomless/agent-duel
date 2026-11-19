import { useCallback } from "react";
import { router } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

const WORKSPACE_NEW_ACTIONS: readonly KeyboardActionId[] = ["workspace.new"];

/**
 * New chat in the project of the chat opened last, so it still lands there from Home or
 * Settings. Without a usable last chat, New chat asks for the project.
 */
export function useNewChatInLastProjectRoute(): ReturnType<typeof buildNewWorkspaceRoute> {
  const selection = useLastWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const lastWorkspace = useWorkspace(serverId, selection?.workspaceId ?? null);
  const supportsWorkspaceMultiplicity = useHostFeature(serverId, "workspaceMultiplicity");
  if (!serverId) {
    return buildNewWorkspaceRoute();
  }
  if (
    !lastWorkspace ||
    !(supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(lastWorkspace.projectKind))
  ) {
    return buildNewWorkspaceRoute({ serverId });
  }
  return buildNewWorkspaceRoute({
    serverId,
    sourceDirectory: lastWorkspace.projectRootPath,
    displayName: lastWorkspace.projectDisplayName,
    projectId: lastWorkspace.projectId,
  });
}

export function useGlobalNewWorkspaceAction() {
  const hosts = useHosts();
  const newChatRoute = useNewChatInLastProjectRoute();

  const handle = useCallback(() => {
    if (hosts.length === 0) {
      return false;
    }
    router.navigate(newChatRoute as never);
    return true;
  }, [hosts.length, newChatRoute]);

  useKeyboardActionHandler({
    handlerId: "workspace-new-global",
    actions: WORKSPACE_NEW_ACTIONS,
    enabled: hosts.length > 0,
    priority: 0,
    handle,
  });
}
