import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GitPullRequest } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import {
  formatPrTabLabel,
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
  usePrPaneData,
} from "@/git/pull-request-panel";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);

/** The side panel's pull request tab for the checkout's open change request. */
function PullRequestPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "pull_request", "PullRequestPanel requires pull_request target");
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isActive = useRetainedPanelActive();
  const prPane = usePrPaneData({
    serverId,
    cwd: cwd ?? "",
    enabled: Boolean(cwd) && isActive,
  });
  const refreshGitActions = useCheckoutGitActionsStore((state) => state.refresh);
  const handleRetry = useCallback(() => {
    if (!cwd) {
      return;
    }
    refreshGitActions({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, refreshGitActions, serverId, t, toast]);
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: cwd ?? "" }),
    [cwd, serverId, workspaceId],
  );

  if (!cwd) {
    return <SidePanelDirectoryMissing />;
  }
  if (prPane.data) {
    return (
      <PullRequestPane
        serverId={serverId}
        cwd={cwd}
        data={prPane.data}
        activityLoading={prPane.activityLoading}
        workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
      />
    );
  }
  if (prPane.error) {
    return <PullRequestPaneError onRetry={handleRetry} />;
  }
  return <PullRequestPaneSkeleton />;
}

function usePullRequestPanelDescriptor(
  _target: { kind: "pull_request" },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(context.serverId, context.workspaceId);
  const prPane = usePrPaneData({
    serverId: context.serverId,
    cwd: cwd ?? "",
    enabled: Boolean(cwd),
    timelineEnabled: false,
  });
  const label =
    prPane.prNumber === null ? t("panels.pullRequest.label") : formatPrTabLabel(prPane.prNumber);
  return {
    label,
    subtitle: t("panels.pullRequest.subtitle"),
    tooltip: t("panels.pullRequest.subtitle"),
    titleState: "ready",
    icon: ThemedGitPullRequest,
    statusBucket: null,
  };
}

export const pullRequestPanelRegistration: PanelRegistration<"pull_request"> = {
  kind: "pull_request",
  component: PullRequestPanel,
  useDescriptor: usePullRequestPanelDescriptor,
};
