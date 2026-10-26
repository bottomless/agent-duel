import { useEffect } from "react";
import { shouldDiscoverPullRequest } from "./activity";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import { autoOpenWorkspacePullRequest } from "@/workspace-tabs/open-supporting-view";
import { getPullRequestIdentity } from "./state";
/** Workspace discovery remains independent from whether an ordinary PR tab exists. */
export function useWorkspacePullRequestDiscovery(input: {
  workspaceKey: string | null;
  serverId: string;
  cwd: string | null;
  workspaceActive: boolean;
  isGit: boolean;
  layoutMode: "compact" | "single-pane" | "split-panes";
  sidePanelOpen: boolean;
}): boolean {
  const enabled = shouldDiscoverPullRequest({
    workspaceActive: input.workspaceActive,
    isGit: input.isGit,
    splitLayout: input.layoutMode === "split-panes",
    explorerActive: input.sidePanelOpen,
  });
  const hasPullRequest = useHasPullRequest({ serverId: input.serverId, cwd: input.cwd, enabled });
  usePullRequestAutoAdd({ workspaceKey: input.workspaceKey, hasPullRequest, enabled });
  return hasPullRequest;
}

/**
 * Whether this workspace's branch has a pull request.
 */
export function useHasPullRequest(input: {
  serverId: string;
  cwd: string | null;
  enabled: boolean;
}): boolean {
  const status = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd || "",
    enabled: input.enabled,
  }).status;
  return getPullRequestIdentity(status) !== null;
}

/** Connects PR detection to the persisted layout after hydration. */
export function usePullRequestAutoAdd(input: {
  workspaceKey: string | null;
  hasPullRequest: boolean;
  enabled: boolean;
}): void {
  const hydrated = useWorkspaceLayoutStoreHydrated();
  useEffect(() => {
    if (hydrated && input.enabled && input.hasPullRequest) {
      autoOpenWorkspacePullRequest({ workspaceKey: input.workspaceKey });
    }
  }, [hydrated, input.enabled, input.hasPullRequest, input.workspaceKey]);
}
