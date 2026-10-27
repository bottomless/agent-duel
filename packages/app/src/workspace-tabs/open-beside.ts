import { revealWorkspaceTab } from "./navigation";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type OpenInSidePaneSource = keyof OpenInSidePanePreferences;

interface OpenPreferredWorkspaceTargetInput {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
  parentTabId?: string | null;
  source: OpenInSidePaneSource;
  preferences: OpenInSidePanePreferences;
}

/**
 * Opens a target implied by something inside a tab (a subagent row, a file in a diff) and reveals
 * it. The target's kind picks its pane (`isSidePanelTabTarget`): supporting views land in the side
 * panel and chats in the main pane, so the per-source side-pane preference has nothing left to
 * choose. An existing tab is revealed where the user left it.
 */
export function openPreferredWorkspaceTarget(
  input: OpenPreferredWorkspaceTargetInput,
): string | null {
  if (!input.workspaceKey) return null;
  return revealWorkspaceTab(
    input.workspaceKey,
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      parentTabId: input.parentTabId ?? undefined,
    }),
  );
}
