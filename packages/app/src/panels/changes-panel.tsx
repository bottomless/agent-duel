import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { GitDiffPane } from "@/git/diff-pane";
import { useAddFileToChat } from "@/hooks/use-add-file-to-chat";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSidePanelBrowseTarget } from "@/panels/side-panel-browse-target";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";

const ThemedGitCompareArrows = withUnistyles(GitCompareArrows);

/**
 * The side panel's Changes tab: the checkout's changed files with their diffs,
 * plus a contestant worktree picker while a battle runs.
 */
function ChangesPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  invariant(target.kind === "changes", "ChangesPanel requires changes target");
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const isActive = useRetainedPanelActive();
  const handleOpenFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "side" }),
    [openFileInWorkspace],
  );
  const { branchTargets, pane } = useSidePanelBrowseTarget({
    serverId,
    workspaceId,
    workspaceRoot: workspaceRoot ?? "",
    onOpenFile: handleOpenFile,
  });
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });

  if (!workspaceRoot) {
    return <SidePanelDirectoryMissing />;
  }

  return (
    <GitDiffPane
      serverId={serverId}
      workspaceId={pane.workspaceId}
      cwd={pane.workspaceRoot}
      enabled={isActive}
      onOpenFile={pane.onOpenFile}
      onAddToChat={canAddToChat && !pane.readOnly ? addFile : undefined}
      branchTargets={branchTargets}
      readOnly={pane.readOnly}
      // A contestant commits as it works and its worktree is detached, so the
      // committed view would diff against the repository base and bury the run.
      // Uncommitted is where its changes are; the menu still offers the other.
      cleanFallbackMode={pane.readOnly ? "uncommitted" : undefined}
    />
  );
}

function useChangesPanelDescriptor(): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: t("panels.changes.label"),
    subtitle: t("panels.changes.subtitle"),
    tooltip: t("panels.changes.subtitle"),
    titleState: "ready",
    icon: ThemedGitCompareArrows,
    statusBucket: null,
  };
}

export const changesPanelRegistration: PanelRegistration<"changes"> = {
  kind: "changes",
  component: ChangesPanel,
  useDescriptor: useChangesPanelDescriptor,
};
