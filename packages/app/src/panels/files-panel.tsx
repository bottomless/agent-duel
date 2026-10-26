import { useCallback } from "react";
import { FolderTree } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useSidePanelBrowseTarget } from "@/panels/side-panel-browse-target";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedFolderTree = withUnistyles(FolderTree);
const filesPanelPresentation = {
  label: (t) => t("panels.files.label"),
  subtitle: (t) => t("panels.files.subtitle"),
  tooltip: (t) => t("panels.files.tooltip"),
  icon: ThemedFolderTree,
} satisfies PanelPresentation;

/**
 * The side panel's Files tab: the workspace file tree. Opening a file adds a
 * file tab beside it; while a battle runs it can browse a contestant worktree.
 */
function FilesPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  invariant(target.kind === "files", "FilesPanel requires files target");
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const handleOpenFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "side" }),
    [openFileInWorkspace],
  );
  const { pane } = useSidePanelBrowseTarget({
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
    <FileExplorerPane
      serverId={serverId}
      workspaceId={pane.workspaceId}
      workspaceRoot={pane.workspaceRoot}
      onOpenFile={pane.onOpenFile}
      onAddToChat={canAddToChat && !pane.readOnly ? addFile : undefined}
      readOnly={pane.readOnly}
    />
  );
}

export const filesPanelRegistration = definePanel("files", {
  component: FilesPanel,
  presentation: filesPanelPresentation,
});
