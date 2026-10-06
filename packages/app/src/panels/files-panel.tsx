import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderTree } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { useAddFileToChat } from "@/hooks/use-add-file-to-chat";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSidePanelBrowseTarget } from "@/panels/side-panel-browse-target";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedFolderTree = withUnistyles(FolderTree);

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

function useFilesPanelDescriptor(): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: t("panels.files.label"),
    subtitle: t("panels.files.subtitle"),
    tooltip: t("panels.files.subtitle"),
    titleState: "ready",
    icon: ThemedFolderTree,
    statusBucket: null,
  };
}

export const filesPanelRegistration: PanelRegistration<"files"> = {
  kind: "files",
  component: FilesPanel,
  useDescriptor: useFilesPanelDescriptor,
};
