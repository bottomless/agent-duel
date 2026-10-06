export type MobilePanelView = "agent" | "agent-list";

export interface MobilePanelSelection {
  target: MobilePanelView;
  revision: number;
}

export interface DesktopSidebarState {
  agentListOpen: boolean;
  focusModeEnabled: boolean;
}

export type SortOption = "name" | "modified" | "size";

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

export interface PanelVisibilityState {
  isAgentListOpen: boolean;
}

export interface PanelLayoutInput {
  isCompact: boolean;
}

export interface PanelCoreState {
  mobilePanel: MobilePanelSelection;
  desktop: DesktopSidebarState;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function clampSidebarWidth(width: number): number {
  return clampNumber(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function selectPanelVisibility(
  state: PanelCoreState,
  input: PanelLayoutInput,
): PanelVisibilityState {
  if (input.isCompact) {
    return { isAgentListOpen: state.mobilePanel.target === "agent-list" };
  }
  return { isAgentListOpen: state.desktop.agentListOpen };
}

export function selectIsAgentListOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isAgentListOpen;
}

export function setMobilePanelTarget(
  selection: MobilePanelSelection,
  target: MobilePanelView,
): MobilePanelSelection {
  if (selection.target === target) {
    return selection;
  }
  return { target, revision: selection.revision + 1 };
}

type MigratablePanelState = Record<string, unknown>;

function migratePanelDesktopFocusMode(state: MigratablePanelState): void {
  const desktop = state.desktop as Record<string, unknown> | undefined;
  if (!desktop) {
    return;
  }
  if ("zoomed" in desktop) {
    desktop.focusModeEnabled = desktop.zoomed;
    delete desktop.zoomed;
  }
  if ("focused" in desktop) {
    desktop.focusModeEnabled = desktop.focused;
    delete desktop.focused;
  }
  if (typeof desktop.focusModeEnabled !== "boolean") {
    desktop.focusModeEnabled = false;
  }
}

// The Explorer sidebar became side panel tabs owned by the workspace layout
// store, so its open state, active tab, width and inner split no longer exist.
function migratePanelV13SidePanel(state: MigratablePanelState): void {
  delete state.explorerTab;
  delete state.explorerTabByCheckout;
  delete state.explorerWidth;
  delete state.explorerFilesSplitRatio;
  const desktop = state.desktop as Record<string, unknown> | undefined;
  if (desktop) {
    delete desktop.fileExplorerOpen;
  }
}

export function migratePanelState(persistedState: unknown, version: number): MigratablePanelState {
  const state = (persistedState ?? {}) as MigratablePanelState;

  if (version < 8) {
    migratePanelDesktopFocusMode(state);
  }
  if (version < 6 || typeof state.sidebarWidth !== "number") {
    state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  }
  if (
    version < 9 ||
    typeof state.expandedPathsByWorkspace !== "object" ||
    !state.expandedPathsByWorkspace
  ) {
    state.expandedPathsByWorkspace = {};
  }
  if (
    version < 10 ||
    typeof state.diffExpandedPathsByWorkspace !== "object" ||
    !state.diffExpandedPathsByWorkspace
  ) {
    state.diffExpandedPathsByWorkspace = {};
  }
  if (
    version < 12 ||
    typeof state.diffCollapsedFoldersByWorkspace !== "object" ||
    !state.diffCollapsedFoldersByWorkspace
  ) {
    state.diffCollapsedFoldersByWorkspace = {};
  }
  if (typeof state.explorerShowHiddenFiles !== "boolean") {
    state.explorerShowHiddenFiles = true;
  }
  if (version < 12) {
    // Compact panel position is transient UI state. Cold starts always begin
    // at content, regardless of what an older version persisted.
    delete state.mobileView;
    delete state.mobilePanel;
  }
  if (version < 13) {
    migratePanelV13SidePanel(state);
  }

  return state;
}
