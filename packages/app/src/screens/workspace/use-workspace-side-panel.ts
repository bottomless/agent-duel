import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePrPaneData } from "@/git/pull-request-panel";
import type { SidePanelLaunchers } from "@/screens/workspace/workspace-desktop-tabs-row";
import {
  getWorkspaceSidePane,
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface UseWorkspaceSidePanelInput {
  persistenceKey: string | null;
  workspaceLayout: WorkspaceLayout | null;
  isRouteFocused: boolean;
  isGitCheckout: boolean;
  normalizedServerId: string;
  workspaceDirectory: string | null;
}

/**
 * The workspace's side panel: its open state, which surfaces its launcher may
 * open, and the handlers the header and pane chrome use. The same on every
 * width; compact widths render the open panel full width instead of beside the
 * chat.
 */
export function useWorkspaceSidePanel({
  persistenceKey,
  workspaceLayout,
  isRouteFocused,
  isGitCheckout,
  normalizedServerId,
  workspaceDirectory,
}: UseWorkspaceSidePanelInput) {
  const { t } = useTranslation();
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const toggleWorkspaceSidePanel = useWorkspaceLayoutStore((state) => state.toggleSidePanel);
  const isSidePanelOpen = useWorkspaceLayoutStore((state) =>
    selectIsWorkspaceSidePanelOpen(state, persistenceKey),
  );
  const sidePaneId = useMemo(
    () => (workspaceLayout ? (getWorkspaceSidePane(workspaceLayout.root)?.id ?? null) : null),
    [workspaceLayout],
  );

  const handleOpenSidePanelTab = useCallback(
    (target: WorkspaceTabTarget) => {
      if (persistenceKey) {
        openWorkspaceTabFocused(persistenceKey, target);
      }
    },
    [openWorkspaceTabFocused, persistenceKey],
  );
  const handleOpenChangesTab = useCallback(() => {
    handleOpenSidePanelTab({ kind: "changes" });
  }, [handleOpenSidePanelTab]);
  const handleToggleSidePanel = useCallback(() => {
    if (persistenceKey) {
      toggleWorkspaceSidePanel(persistenceKey);
    }
  }, [persistenceKey, toggleWorkspaceSidePanel]);
  const pullRequestPane = usePrPaneData({
    serverId: normalizedServerId,
    cwd: workspaceDirectory ?? "",
    enabled: isRouteFocused && isGitCheckout && Boolean(workspaceDirectory),
    timelineEnabled: false,
  });
  const sidePanelLaunchers = useMemo<SidePanelLaunchers>(
    () => ({
      changes: isGitCheckout,
      files: true,
      pullRequest: isGitCheckout && pullRequestPane.prNumber !== null,
    }),
    [isGitCheckout, pullRequestPane.prNumber],
  );

  const sidePanelToggleLabel = useMemo(
    () =>
      isSidePanelOpen ? t("workspace.tabs.sidePanel.close") : t("workspace.tabs.sidePanel.open"),
    [isSidePanelOpen, t],
  );
  const sidePanelToggleAccessibilityState = useMemo(
    () => ({ expanded: isSidePanelOpen }),
    [isSidePanelOpen],
  );

  return {
    isSidePanelOpen,
    sidePaneId,
    sidePanelLaunchers,
    sidePanelToggleLabel,
    sidePanelToggleAccessibilityState,
    handleOpenSidePanelTab,
    handleOpenChangesTab,
    handleToggleSidePanel,
  };
}
