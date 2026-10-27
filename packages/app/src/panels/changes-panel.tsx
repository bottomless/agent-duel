import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { ChangesSurface } from "@/git/diff-pane";
import { useAddFileToChat } from "@/hooks/use-add-file-to-chat";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { changesStateSchema, defaultChangesState } from "@/panels/changes/state";
import { usePanelState } from "@/panels/use-panel-state";
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
  const [changesState, setChangesState] = usePanelState(changesStateSchema, defaultChangesState);
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
    <ChangesSurface
      serverId={serverId}
      workspaceId={pane.workspaceId}
      cwd={pane.workspaceRoot}
      enabled={isActive}
      onOpenFile={pane.onOpenFile}
      onAddToChat={canAddToChat && !pane.readOnly ? addFile : undefined}
      branchTargets={branchTargets}
      readOnly={pane.readOnly}
      state={changesState}
      onStateChange={setChangesState}
      // A contestant commits as it works and its worktree is detached, so all changes and
      // the committed view would diff against the repository base and bury the run.
      // Uncommitted is where its changes are; the menu still offers the others.
      defaultComparison={pane.readOnly ? "uncommitted" : undefined}
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

export const changesPanelRegistration = definePanel("changes", {
  component: ChangesPanel,
  useDescriptor: useChangesPanelDescriptor,
});
