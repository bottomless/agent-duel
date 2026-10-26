import { revealWorkspaceTab } from "./navigation";
import {
  collectAllTabs,
  getWorkspaceSidePane,
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { OpenInSidePanePreferences, PullRequestOpenLocation } from "@/hooks/use-settings";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

interface WorkspaceViewInput {
  isCompact: boolean;
  workspaceKey: string | null;
}

interface OpenWorkspaceChangesInput extends WorkspaceViewInput {
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspacePullRequestInput extends WorkspaceViewInput {
  /** The pull request is a side panel tab, so every location resolves to the side panel. */
  destination: PullRequestOpenLocation;
}

const CHANGES_TARGET: WorkspaceTabTarget = { kind: "changes" };
const PULL_REQUEST_TARGET: WorkspaceTabTarget = { kind: "pull_request" };

function revealSidePanelTarget(workspaceKey: string | null, target: WorkspaceTabTarget) {
  if (!workspaceKey) return null;
  return revealWorkspaceTab(
    workspaceKey,
    useWorkspaceLayoutStore.getState().openTab({ workspaceKey, target, intent: "reveal" }),
  );
}

/** Whether the side panel is showing, with Changes as its visible tab. */
function isSidePanelShowingChanges(workspaceKey: string): boolean {
  const state = useWorkspaceLayoutStore.getState();
  if (!selectIsWorkspaceSidePanelOpen(state, workspaceKey)) return false;
  const layout = state.layoutByWorkspace[workspaceKey];
  const sidePane = layout ? getWorkspaceSidePane(layout.root) : null;
  if (!layout || !sidePane) return false;
  return collectAllTabs(layout.root).some(
    (tab) => tab.tabId === sidePane.focusedTabId && tab.target.kind === CHANGES_TARGET.kind,
  );
}

/** Opens the workspace's Changes in the side panel and reveals it. */
export function openWorkspaceChanges(input: OpenWorkspaceChangesInput): string | null {
  return revealSidePanelTarget(input.workspaceKey, CHANGES_TARGET);
}

/**
 * Reveals Changes from the composer. Once the side panel already shows it, a desktop press opens
 * the full Diff tab from there; compact widths keep showing Changes.
 */
export function openComposerChanges(input: OpenWorkspaceChangesInput): string | null {
  if (!input.workspaceKey) return null;
  if (input.isCompact || !isSidePanelShowingChanges(input.workspaceKey)) {
    return openWorkspaceChanges(input);
  }
  return openPreferredWorkspaceTarget({
    workspaceKey: input.workspaceKey,
    target: { kind: "working_diff" },
    source: "diffs",
    preferences: input.preferences,
  });
}

/** Opens the workspace pull request in the side panel and reveals it. */
export function openWorkspacePullRequest(input: OpenWorkspacePullRequestInput): string | null {
  return revealSidePanelTarget(input.workspaceKey, PULL_REQUEST_TARGET);
}

/**
 * Adds a detected pull request to the side panel once, after Changes when the panel has it,
 * without moving focus or revealing a hidden panel. A PR tab the user already placed stays put.
 */
export function autoOpenWorkspacePullRequest(input: {
  workspaceKey: string | null;
}): string | null {
  if (!input.workspaceKey) return null;
  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();
  return store.autoOpenPullRequestTab(workspaceKey, () => {
    const layout = store.layoutByWorkspace[workspaceKey];
    const sidePane = layout ? getWorkspaceSidePane(layout.root) : null;
    const changes =
      layout && sidePane
        ? collectAllTabs(layout.root).find(
            (tab) => tab.target.kind === CHANGES_TARGET.kind && sidePane.tabIds.includes(tab.tabId),
          )
        : undefined;
    return changes ? { insertionPosition: { afterTabId: changes.tabId } } : {};
  });
}
