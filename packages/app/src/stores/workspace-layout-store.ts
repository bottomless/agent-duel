import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import type { z } from "zod";
import { WorkspaceLayoutPersistedStateSchema } from "./workspace-layout-storage";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  defaultWorkspaceLayoutIds,
  type WorkspaceLayoutIdSource,
} from "@/stores/workspace-layout-ids";
import {
  canDismissPaneInLayout,
  clampNormalizedSizes,
  closePaneInLayout,
  closeTabInLayout,
  collectAllPanes,
  collectAllTabs,
  convertDraftToAgentInLayout,
  createTabInLayout,
  createDefaultLayout,
  DEFAULT_PANE_ID,
  AMBIENT_PLACEMENT,
  ensureSidePaneInLayout,
  FOCUSED_PANE_PLACEMENT,
  findPaneById,
  findPaneContainingTab,
  focusPaneInLayout,
  focusTabInLayout,
  getFocusedBrowserId,
  getWorkspaceMainPane,
  getWorkspaceSidePane,
  isSidePanelTabTarget,
  moveTabToPaneInLayout,
  normalizeLayout,
  openTabInLayoutBackground,
  replaceTabTargetInLayout,
  revealTargetInLayout,
  restoreWorkspaceLayout,
  reconcileWorkspaceTabs,
  removeEmptySidePaneInLayout,
  removePaneFromTree,
  removeTabFromTree,
  reorderFocusedPaneTabsInLayout,
  reorderPaneTabsInLayout,
  setTabStateInLayout,
  selectTabInPaneInLayout,
  SIDE_PANE_DEFAULT_SIZE,
  stripEphemeralTabsFromLayout,
  type SplitGroup,
  type SplitNode,
  type SplitPane,
  type WorkspaceTabPlacement,
  type WorkspaceTabInsertionPosition,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
} from "@/workspace-tabs/identity";
import { isSheetTabModified, resolveCompactSheetPolicy } from "@/workspace-tabs/compact-sheet";
import { panelResourceKey, type CompactSheetPolicy } from "@/panels/panel-manifest";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export {
  AMBIENT_PLACEMENT,
  canDismissPaneInLayout,
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  DEFAULT_PANE_ID,
  FOCUSED_PANE_PLACEMENT,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  getWorkspaceMainPane,
  getWorkspaceSidePane,
  isSidePanelTabTarget,
  normalizeLayout,
  removePaneFromTree,
  removeTabFromTree,
  SIDE_PANE_DEFAULT_SIZE,
  stripEphemeralTabsFromLayout,
};
export type {
  SplitGroup,
  SplitNode,
  SplitPane,
  WorkspaceLayout,
  WorkspaceTabPlacement,
  WorkspaceTabReconcileState,
  WorkspaceTabSnapshot,
};

export type WorkspaceTabOpenIntent = "new" | "reveal" | "background";
export interface OpenWorkspaceTabInput {
  workspaceKey: string;
  target: WorkspaceTabTarget;
  intent: WorkspaceTabOpenIntent;
  /** Keeps an explicitly opened agent visible even when it is archived. */
  pin?: boolean;
  placement?: WorkspaceTabPlacement;
  insertionPosition?: WorkspaceTabInsertionPosition;
  parentTabId?: string;
  state?: JsonValue;
}

/**
 * How the app shell lays out a workspace: compact (one pane at a time, plus sheets), a single
 * wide pane (touch tablets, which cannot render splits), or the chat and the side panel side by
 * side.
 */
export type WorkspaceLayoutMode = "compact" | "single-pane" | "split-panes";

/** A tab shown in a sheet over the compact workspace instead of in a pane. */
export interface SheetTab {
  tab: WorkspaceTab;
  policy: CompactSheetPolicy;
  parentTabId: string | null;
}

export type WorkspaceTabDestination =
  | { kind: "pane"; paneId: string; host: "main" | "side"; tabId: string }
  | { kind: "sheet"; tabId: string };

interface WorkspaceLayoutStore {
  panelRevisionByWorkspace: Record<string, Record<string, number>>;
  /** Published once by the app shell; callers never pass a form factor to open a tab. */
  layoutMode: WorkspaceLayoutMode;
  pendingOpenByWorkspace: Record<string, OpenWorkspaceTabInput>;
  deferOpenTab: (input: OpenWorkspaceTabInput) => null;
  consumePendingOpen: (workspaceKey: string) => string | null;
  /**
   * Each workspace's sheet tabs in the order they opened, so the last is the sheet on top. The
   * list never reorders: the stack belongs to the sheet primitive, and moving a sheet would remount
   * its panel. A workspace with no sheet has no entry. Not persisted: a reload returns to the tab
   * strip.
   */
  sheetsByWorkspace: Record<string, readonly SheetTab[]>;
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  splitSizesByWorkspace: Record<string, Record<string, number[]>>;
  /**
   * Whether the side panel is shown. Absent means open. Hiding the panel keeps
   * its tabs; focusing or opening a side-panel tab reveals it again.
   */
  sidePanelOpenByWorkspace: Record<string, boolean>;
  pinnedAgentIdsByWorkspace: Record<string, Set<string>>;
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  focusRestorationByWorkspace: Record<string, WorkspaceFocusRestorationState>;
  /** Workspaces where PR detection already added its tab once; a closed tab never returns. */
  pullRequestTabAutoOpenedByWorkspace: Record<string, true>;
  /**
   * The one entry point for showing a target. The target's kind picks its pane
   * (`isSidePanelTabTarget`); callers never name one for a new tab. On compact
   * layouts a target whose panel declares `compactSheet` opens in a sheet; the
   * returned tab id is the sheet tab's id.
   */
  openTab: (input: OpenWorkspaceTabInput) => string | null;
  /** Whether `openTab` with this input would show the target in a sheet. */
  opensInSheet: (
    input: Pick<OpenWorkspaceTabInput, "workspaceKey" | "target" | "intent">,
  ) => boolean;
  setLayoutMode: (mode: WorkspaceLayoutMode) => void;
  /** Moves a sheet's tab, keeping its tab id, into the pane its kind belongs to. */
  openSheetAsTab: (workspaceKey: string, tabId: string) => string | null;
  /** Placement resolves lazily so an already acknowledged workspace never computes one. */
  autoOpenPullRequestTab: (
    workspaceKey: string,
    resolvePlacement: () => Pick<OpenWorkspaceTabInput, "placement" | "insertionPosition">,
  ) => string | null;
  /**
   * Returns the side pane, creating an empty one (the launcher) when absent. With
   * focus, the panel is revealed and lands focus in it.
   */
  ensureSidePane: (workspaceKey: string, options?: { focus: boolean }) => string | null;
  closeTab: (workspaceKey: string, tabId: string) => void;
  getTabDestination: (workspaceKey: string, tabId: string) => WorkspaceTabDestination | null;
  focusTab: (workspaceKey: string, tabId: string) => void;
  selectTabInPane: (workspaceKey: string, paneId: string, tabId: string) => void;
  replaceTab: (
    workspaceKey: string,
    tabId: string,
    target: WorkspaceTabTarget,
    state?: JsonValue,
  ) => string | null;
  setTabState: (workspaceKey: string, tabId: string, state: JsonValue | undefined) => void;
  convertDraftToAgent: (workspaceKey: string, tabId: string, agentId: string) => string | null;
  reconcileTabs: (workspaceKey: string, snapshot: WorkspaceTabSnapshot) => void;
  reorderTabs: (workspaceKey: string, tabIds: string[]) => void;
  getWorkspaceTabs: (workspaceKey: string) => WorkspaceTab[];
  setSidePanelOpen: (workspaceKey: string, open: boolean) => void;
  toggleSidePanel: (workspaceKey: string) => void;
  moveTabToPane: (workspaceKey: string, tabId: string, toPaneId: string) => void;
  /**
   * Empties the side pane and leaves it on its launcher. Callers own tab teardown
   * (archiving agents, killing terminals) first. No-ops on the main pane.
   */
  closePane: (workspaceKey: string, paneId: string) => void;
  focusPane: (workspaceKey: string, paneId: string) => void;
  unfocusPane: (workspaceKey: string) => string | null;
  restorePaneFocus: (workspaceKey: string, token: string) => void;
  resizeSplit: (workspaceKey: string, groupId: string, sizes: number[]) => void;
  reorderTabsInPane: (workspaceKey: string, paneId: string, tabIds: string[]) => void;
  unpinAgent: (workspaceKey: string, agentId: string) => void;
  hideAgent: (workspaceKey: string, agentId: string) => void;
  unhideAgent: (workspaceKey: string, agentId: string) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

interface WorkspaceFocusRestorationState {
  restorePaneId: string | null;
  tokens: string[];
}

const WORKSPACE_LAYOUT_PERSIST_VERSION = 2;
type WorkspaceLayoutPersistedState = z.infer<typeof WorkspaceLayoutPersistedStateSchema>;

/**
 * Persisted layouts need no conversion between versions: `normalizeLayout`
 * flattens any older tree into the main pane and side pane when it loads.
 */
function migrateWorkspaceLayoutPersistedState(
  persistedState: unknown,
): WorkspaceLayoutPersistedState {
  const result = WorkspaceLayoutPersistedStateSchema.safeParse(persistedState);
  return result.success ? result.data : { layoutByWorkspace: {} };
}

/**
 * Whether the side panel is showing: it has a pane and that pane is not hidden.
 * A workspace that never opened a side-panel tab reads as closed, so the header
 * toggle's first press creates the pane instead of hiding nothing.
 */
export function selectIsWorkspaceSidePanelOpen(
  state: Pick<WorkspaceLayoutStore, "sidePanelOpenByWorkspace" | "layoutByWorkspace">,
  workspaceKey: string | null,
): boolean {
  if (!workspaceKey) {
    return false;
  }
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout || getWorkspaceSidePane(layout.root) === null) {
    return false;
  }
  return state.sidePanelOpenByWorkspace[workspaceKey] ?? true;
}

/**
 * Landing focus in the side pane reveals a hidden side panel, so a tab the
 * person just opened or dragged over is never focused while invisible.
 */
function revealSidePanelForFocus(
  state: Pick<WorkspaceLayoutStore, "sidePanelOpenByWorkspace">,
  workspaceKey: string,
  layout: WorkspaceLayout,
): Pick<WorkspaceLayoutStore, "sidePanelOpenByWorkspace"> | null {
  if (state.sidePanelOpenByWorkspace[workspaceKey] ?? true) {
    return null;
  }
  const sidePane = getWorkspaceSidePane(layout.root);
  if (!sidePane || layout.focusedPaneId !== sidePane.id) {
    return null;
  }
  const { [workspaceKey]: _closed, ...sidePanelOpenByWorkspace } = state.sidePanelOpenByWorkspace;
  return { sidePanelOpenByWorkspace };
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createWorkspaceTabInstanceId(): string {
  const value =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `tab_${value}`;
}

function addAgentIdToWorkspaceSet(
  state: Record<string, Set<string>>,
  workspaceKey: string,
  agentId: string,
): Record<string, Set<string>> {
  const currentAgentIds = state[workspaceKey] ?? null;
  if (currentAgentIds?.has(agentId)) {
    return state;
  }

  const nextAgentIds = new Set(currentAgentIds ?? []);
  nextAgentIds.add(agentId);
  return {
    ...state,
    [workspaceKey]: nextAgentIds,
  };
}

function removeAgentIdFromWorkspaceSet(
  state: Record<string, Set<string>>,
  workspaceKey: string,
  agentId: string,
): Record<string, Set<string>> {
  const currentAgentIds = state[workspaceKey] ?? null;
  if (!currentAgentIds?.has(agentId)) {
    return state;
  }

  if (currentAgentIds.size === 1) {
    const nextState = { ...state };
    delete nextState[workspaceKey];
    return nextState;
  }

  const nextAgentIds = new Set(currentAgentIds);
  nextAgentIds.delete(agentId);
  return {
    ...state,
    [workspaceKey]: nextAgentIds,
  };
}

function getWorkspaceLayout(
  state: Record<string, WorkspaceLayout>,
  workspaceKey: string,
): WorkspaceLayout {
  return normalizeLayout(state[workspaceKey] ?? createDefaultLayout());
}

/** A workspace's panes give up keyboard focus while focus is parked or the sheet covers them. */
export function selectPaneFocusSuspended(
  state: Pick<WorkspaceLayoutStore, "focusRestorationByWorkspace" | "sheetsByWorkspace">,
  workspaceKey: string,
): boolean {
  return (
    Boolean(state.focusRestorationByWorkspace[workspaceKey]?.restorePaneId) ||
    workspaceKey in state.sheetsByWorkspace
  );
}

function getOpenTabPlacement(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  placement: WorkspaceTabPlacement | undefined,
): {
  layout: WorkspaceLayout;
  placement: WorkspaceTabPlacement;
} {
  return {
    layout: getWorkspaceLayout(state.layoutByWorkspace, workspaceKey),
    placement: placement ?? AMBIENT_PLACEMENT,
  };
}

function withoutFocusRestoration(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
): Pick<WorkspaceLayoutStore, "focusRestorationByWorkspace"> | null {
  if (!(workspaceKey in state.focusRestorationByWorkspace)) {
    return null;
  }
  const { [workspaceKey]: _removed, ...focusRestorationByWorkspace } =
    state.focusRestorationByWorkspace;
  return { focusRestorationByWorkspace };
}

function attachParentTab(input: {
  layout: WorkspaceLayout;
  childTabId: string | null;
  parentTabId: string | null;
}): WorkspaceLayout {
  const childTabId = trimNonEmpty(input.childTabId);
  const parentTabId = trimNonEmpty(input.parentTabId);
  if (!childTabId || !parentTabId || childTabId === parentTabId) {
    return normalizeLayout(input.layout);
  }

  const openTabIds = new Set(collectAllTabs(input.layout.root).map((tab) => tab.tabId));
  if (!openTabIds.has(childTabId) || !openTabIds.has(parentTabId)) {
    return normalizeLayout(input.layout);
  }

  return normalizeLayout({
    ...input.layout,
    parentTabIdByTabId: {
      ...input.layout.parentTabIdByTabId,
      [childTabId]: parentTabId,
    },
  });
}

const NO_SHEETS: readonly SheetTab[] = [];

function getSheets(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
): readonly SheetTab[] {
  return state.sheetsByWorkspace[workspaceKey] ?? NO_SHEETS;
}

function findSheet(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
): SheetTab | undefined {
  return getSheets(state, workspaceKey).find((sheet) => sheet.tab.tabId === tabId);
}

function withSheets(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
  sheets: readonly SheetTab[],
): Pick<WorkspaceLayoutStore, "sheetsByWorkspace"> {
  if (sheets.length > 0) {
    return { sheetsByWorkspace: { ...state.sheetsByWorkspace, [workspaceKey]: sheets } };
  }
  if (!(workspaceKey in state.sheetsByWorkspace)) {
    return { sheetsByWorkspace: state.sheetsByWorkspace };
  }
  const { [workspaceKey]: _removed, ...sheetsByWorkspace } = state.sheetsByWorkspace;
  return { sheetsByWorkspace };
}

function withoutSheet(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
): Pick<WorkspaceLayoutStore, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).filter((sheet) => sheet.tab.tabId !== tabId),
  );
}

function withSheetTab(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
  update: (sheet: SheetTab) => SheetTab,
): Pick<WorkspaceLayoutStore, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).map((sheet) =>
      sheet.tab.tabId === tabId ? update(sheet) : sheet,
    ),
  );
}

function isTargetOpenAsTab(layout: WorkspaceLayout | undefined, target: WorkspaceTabTarget) {
  if (!layout) return false;
  const resourceKey = panelResourceKey(target);
  return collectAllTabs(layout.root).some((tab) => panelResourceKey(tab.target) === resourceKey);
}

function resolveSheetPolicy(
  state: Pick<WorkspaceLayoutStore, "layoutMode" | "layoutByWorkspace">,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  intent: WorkspaceTabOpenIntent,
): CompactSheetPolicy | null {
  if (state.layoutMode !== "compact" || intent === "background") return null;
  if (intent === "reveal" && isTargetOpenAsTab(state.layoutByWorkspace[workspaceKey], target)) {
    return null;
  }
  return resolveCompactSheetPolicy(workspaceKey, target);
}

/**
 * The parent a newly opened tab links to. A sheet tab is not in the layout, so a target opened
 * from inside a sheet inherits that sheet's own parent instead.
 */
function resolveOpenParentTabId(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
  parentTabId: string | undefined,
): string | null {
  if (!parentTabId) return null;
  return findSheet(state, workspaceKey, parentTabId)?.parentTabId ?? parentTabId;
}

function placeTargetInSheet(input: {
  /** The sheet whose tab the target keeps, if any. */
  kept: SheetTab | undefined;
  target: WorkspaceTabTarget;
  intent: WorkspaceTabOpenIntent;
  policy: CompactSheetPolicy;
  parentTabId: string | null;
  state: JsonValue | undefined;
}): SheetTab {
  if (input.kept) {
    return { ...input.kept, tab: { ...input.kept.tab, target: input.target } };
  }
  return {
    tab: {
      tabId:
        input.intent === "reveal"
          ? buildDeterministicWorkspaceTabId(input.target)
          : createWorkspaceTabInstanceId(),
      target: input.target,
      createdAt: Date.now(),
      ...(input.state !== undefined ? { state: input.state } : {}),
    },
    policy: input.policy,
    parentTabId: input.parentTabId,
  };
}

/**
 * Moves one sheet's tab into the pane its kind belongs to, keeping its tab id and state. The
 * other sheets stay; callers that bring the tab to the front dismiss them.
 */
function promoteSheetToTab(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  tabId: string,
  createNodeId: WorkspaceLayoutIdSource["createNodeId"],
): { tabId: string; patch: Partial<WorkspaceLayoutStore> } | null {
  const sheet = findSheet(state, workspaceKey, tabId);
  if (!sheet) return null;
  const { tab } = sheet;
  const placement = getOpenTabPlacement(state, workspaceKey, FOCUSED_PANE_PLACEMENT);
  const input = {
    ...placement,
    target: tab.target,
    now: tab.createdAt,
    createNodeId,
    createTabId: () => tab.tabId,
    state: tab.state,
  };
  const result = isTargetOpenAsTab(placement.layout, tab.target)
    ? revealTargetInLayout(input)
    : createTabInLayout(input);
  if (!result) return null;
  const nextLayout = attachParentTab({
    layout: result.layout,
    childTabId: result.tabId,
    parentTabId: sheet.parentTabId,
  });
  return {
    tabId: result.tabId,
    patch: {
      ...withoutSheet(state, workspaceKey, tab.tabId),
      ...withoutFocusRestoration(state, workspaceKey),
      ...revealSidePanelForFocus(state, workspaceKey, nextLayout),
      hiddenAgentIdsByWorkspace:
        tab.target.kind === "agent"
          ? removeAgentIdFromWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              workspaceKey,
              tab.target.agentId,
            )
          : state.hiddenAgentIdsByWorkspace,
      layoutByWorkspace: { ...state.layoutByWorkspace, [workspaceKey]: nextLayout },
    },
  };
}

/**
 * A sheet holding unsaved work is never implicitly displaced: moving its tab would remount the
 * panel and drop the work. Only the explicit, guarded close removes it.
 */
function sheetHoldsUnsavedWork(workspaceKey: string, sheet: SheetTab): boolean {
  return isSheetTabModified(workspaceKey, sheet.tab.tabId);
}

/**
 * Where an open lands among the sheet tabs, or null when it opens as a tab. A new target goes on
 * top. A reveal of a resource a sheet already shows keeps that sheet's tab and uncovers it by
 * closing the sheets above it, except ones holding unsaved work, which stay where they are.
 */
function resolveSheetPlacement(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  intent: WorkspaceTabOpenIntent,
): { policy: CompactSheetPolicy; keptIndex: number | null } | null {
  const policy = resolveSheetPolicy(state, workspaceKey, target, intent);
  if (!policy) return null;
  if (intent !== "reveal") return { policy, keptIndex: null };
  const sheets = getSheets(state, workspaceKey);
  const resourceKey = panelResourceKey(target);
  const index = sheets.findIndex((sheet) => panelResourceKey(sheet.tab.target) === resourceKey);
  return { policy, keptIndex: index === -1 ? null : index };
}

/** Closes the sheets because navigation moved on underneath them, except ones with unsaved work. */
function dismissSheets(
  state: Pick<WorkspaceLayoutStore, "sheetsByWorkspace">,
  workspaceKey: string,
): Pick<WorkspaceLayoutStore, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).filter((sheet) => sheetHoldsUnsavedWork(workspaceKey, sheet)),
  );
}

/** Moves a sheet's tab to the front of the tab strip, dismissing the sheets that would cover it. */
function openSheetTabInFront(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  tabId: string,
  createNodeId: WorkspaceLayoutIdSource["createNodeId"],
): { tabId: string; patch: Partial<WorkspaceLayoutStore> } | null {
  const promoted = promoteSheetToTab(state, workspaceKey, tabId, createNodeId);
  if (!promoted) return null;
  const next = { ...state, ...promoted.patch };
  return {
    tabId: promoted.tabId,
    patch: { ...promoted.patch, ...dismissSheets(next, workspaceKey) },
  };
}

/**
 * A sheet agent closes once the workspace no longer has it (archived or gone), like its tab would,
 * and once it stops being a subagent: as a root agent, reconcile gives it its own tab, and the sheet
 * would hold a second tab with the same id.
 */
function sheetAgentNoLongerFits(
  workspaceKey: string,
  sheet: SheetTab,
  snapshot: WorkspaceTabSnapshot,
): boolean {
  if (sheet.tab.target.kind !== "agent" || !snapshot.agentsHydrated) return false;
  if (!new Set(snapshot.activeAgentIds).has(sheet.tab.target.agentId)) return true;
  return resolveCompactSheetPolicy(workspaceKey, sheet.tab.target) === null;
}

const PERSISTED_SLICES = [
  "layoutByWorkspace",
  "pinnedAgentIdsByWorkspace",
  "splitSizesByWorkspace",
  "sidePanelOpenByWorkspace",
  "pullRequestTabAutoOpenedByWorkspace",
] as const;

// Zustand persist re-runs partialize after every set, including ones that return the state
// untouched. Reusing the previous projection while every persisted slice is the same
// reference lets validated storage skip unchanged writes before validation and serialization.
function createPersistedStateProjection() {
  let previous: { source: WorkspaceLayoutStore; state: WorkspaceLayoutPersistedState } | null =
    null;
  return (source: WorkspaceLayoutStore): WorkspaceLayoutPersistedState => {
    const last = previous;
    if (last && PERSISTED_SLICES.every((slice) => last.source[slice] === source[slice])) {
      return last.state;
    }
    const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
    for (const key in source.layoutByWorkspace) {
      // Strip ephemeral (commit diff) tabs before persisting so they are
      // dropped on reload rather than restored pointing at a rebased SHA.
      layoutByWorkspace[key] = stripEphemeralTabsFromLayout(
        normalizeLayout(source.layoutByWorkspace[key]),
      );
    }
    const state: WorkspaceLayoutPersistedState = {
      layoutByWorkspace,
      pinnedAgentIdsByWorkspace: Object.fromEntries(
        Object.entries(source.pinnedAgentIdsByWorkspace).map(([key, agentIds]) => [
          key,
          Array.from(agentIds),
        ]),
      ),
      splitSizesByWorkspace: source.splitSizesByWorkspace,
      sidePanelOpenByWorkspace: source.sidePanelOpenByWorkspace,
      pullRequestTabAutoOpenedByWorkspace: source.pullRequestTabAutoOpenedByWorkspace,
    };
    previous = { source, state };
    return state;
  };
}

function advancePanelRevision(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  tabId: string,
  target: WorkspaceTabTarget,
) {
  if (target.kind !== "file" && target.kind !== "plugin") return {};
  const revisions = state.panelRevisionByWorkspace[workspaceKey] ?? {};
  return {
    panelRevisionByWorkspace: {
      ...state.panelRevisionByWorkspace,
      [workspaceKey]: { ...revisions, [tabId]: (revisions[tabId] ?? 0) + 1 },
    },
  };
}

export function createWorkspaceLayoutStore(
  ids: WorkspaceLayoutIdSource = defaultWorkspaceLayoutIds,
  storage: StateStorage = AsyncStorage,
) {
  return create<WorkspaceLayoutStore>()(
    persist(
      (set, get) => ({
        autoOpenPullRequestTab: (workspaceKey, resolvePlacement) => {
          const key = trimNonEmpty(workspaceKey);
          if (!key || get().pullRequestTabAutoOpenedByWorkspace[key]) return null;
          const tabId = get().openTab({
            workspaceKey: key,
            target: { kind: "pull_request" },
            intent: "background",
            ...resolvePlacement(),
          });
          if (tabId) {
            set((state) => ({
              pullRequestTabAutoOpenedByWorkspace: {
                ...state.pullRequestTabAutoOpenedByWorkspace,
                [key]: true,
              },
            }));
          }
          return tabId;
        },
        panelRevisionByWorkspace: {},
        pendingOpenByWorkspace: {},
        deferOpenTab: (input) => {
          set((state) => ({
            pendingOpenByWorkspace: {
              ...state.pendingOpenByWorkspace,
              [input.workspaceKey]: input,
            },
          }));
          return null;
        },
        consumePendingOpen: (workspaceKey) => {
          const pending = get().pendingOpenByWorkspace[workspaceKey];
          if (!pending) return null;
          set((state) => {
            const { [workspaceKey]: _pending, ...pendingOpenByWorkspace } =
              state.pendingOpenByWorkspace;
            return { pendingOpenByWorkspace };
          });
          return get().openTab(pending);
        },
        layoutMode: "split-panes",
        sheetsByWorkspace: {},
        layoutByWorkspace: {},
        splitSizesByWorkspace: {},
        sidePanelOpenByWorkspace: {},
        pinnedAgentIdsByWorkspace: {},
        hiddenAgentIdsByWorkspace: {},
        focusRestorationByWorkspace: {},
        pullRequestTabAutoOpenedByWorkspace: {},
        openTab: (input) => {
          const normalizedWorkspaceKey = trimNonEmpty(input.workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }
          const parentTabId = resolveOpenParentTabId(
            get(),
            normalizedWorkspaceKey,
            input.parentTabId,
          );
          const sheetPlacement =
            input.placement?.mode === "pane"
              ? null
              : resolveSheetPlacement(
                  get(),
                  normalizedWorkspaceKey,
                  normalizedTarget,
                  input.intent,
                );
          if (sheetPlacement) {
            const sheets = getSheets(get(), normalizedWorkspaceKey);
            const { keptIndex } = sheetPlacement;
            const sheet = placeTargetInSheet({
              kept: keptIndex === null ? undefined : sheets[keptIndex],
              target: normalizedTarget,
              intent: input.intent,
              policy: sheetPlacement.policy,
              parentTabId,
              state: input.state,
            });
            const next =
              keptIndex === null
                ? [...sheets, sheet]
                : sheets.flatMap((existing, index) => {
                    if (index === keptIndex) return [sheet];
                    if (index < keptIndex) return [existing];
                    return sheetHoldsUnsavedWork(normalizedWorkspaceKey, existing)
                      ? [existing]
                      : [];
                  });
            set((state) => ({
              ...withSheets(state, normalizedWorkspaceKey, next),
              ...advancePanelRevision(
                state,
                normalizedWorkspaceKey,
                sheet.tab.tabId,
                normalizedTarget,
              ),
            }));
            return sheet.tab.tabId;
          }
          const placement = getOpenTabPlacement(get(), normalizedWorkspaceKey, input.placement);
          let result;
          if (input.intent === "new") {
            result = createTabInLayout({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
              createNodeId: ids.createNodeId,
              createTabId: createWorkspaceTabInstanceId,
              state: input.state,
            });
          } else if (input.intent === "background") {
            result = openTabInLayoutBackground({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
              createNodeId: ids.createNodeId,
            });
          } else {
            result = revealTargetInLayout({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
              createNodeId: ids.createNodeId,
              createTabId: createWorkspaceTabInstanceId,
            });
          }
          if (!result) {
            return null;
          }
          const nextLayout = result.layout;
          const shouldPinAgent = input.pin === true && normalizedTarget.kind === "agent";
          set((state) => ({
            ...withoutFocusRestoration(state, normalizedWorkspaceKey),
            ...revealSidePanelForFocus(state, normalizedWorkspaceKey, nextLayout),
            ...advancePanelRevision(state, normalizedWorkspaceKey, result.tabId, normalizedTarget),
            // A tab brought to the front dismisses the sheet over it.
            ...(input.intent === "background" ? {} : dismissSheets(state, normalizedWorkspaceKey)),
            hiddenAgentIdsByWorkspace:
              normalizedTarget.kind !== "agent"
                ? state.hiddenAgentIdsByWorkspace
                : removeAgentIdFromWorkspaceSet(
                    state.hiddenAgentIdsByWorkspace,
                    normalizedWorkspaceKey,
                    normalizedTarget.agentId,
                  ),
            pinnedAgentIdsByWorkspace: shouldPinAgent
              ? addAgentIdToWorkspaceSet(
                  state.pinnedAgentIdsByWorkspace,
                  normalizedWorkspaceKey,
                  normalizedTarget.agentId,
                )
              : state.pinnedAgentIdsByWorkspace,
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: parentTabId
                ? attachParentTab({
                    layout: nextLayout,
                    childTabId: result.tabId,
                    parentTabId,
                  })
                : nextLayout,
            },
          }));
          return result.tabId;
        },
        opensInSheet: (input) => {
          const normalizedWorkspaceKey = trimNonEmpty(input.workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
          if (!normalizedWorkspaceKey || !normalizedTarget) return false;
          return (
            resolveSheetPlacement(get(), normalizedWorkspaceKey, normalizedTarget, input.intent) !==
            null
          );
        },
        setLayoutMode: (mode) => {
          set((state) => {
            if (state.layoutMode === mode) return state;
            if (mode === "compact") return { layoutMode: mode };
            // Widening keeps whatever the user had open in sheets as ordinary tabs.
            const next: WorkspaceLayoutStore = { ...state, layoutMode: mode };
            for (const [workspaceKey, sheets] of Object.entries(state.sheetsByWorkspace)) {
              for (const sheet of sheets) {
                const promoted = promoteSheetToTab(
                  next,
                  workspaceKey,
                  sheet.tab.tabId,
                  ids.createNodeId,
                );
                Object.assign(
                  next,
                  promoted?.patch ?? withoutSheet(next, workspaceKey, sheet.tab.tabId),
                );
              }
            }
            return next;
          });
        },
        openSheetAsTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) return null;
          const promoted = openSheetTabInFront(
            get(),
            normalizedWorkspaceKey,
            normalizedTabId,
            ids.createNodeId,
          );
          if (!promoted) return null;
          set(promoted.patch);
          return promoted.tabId;
        },
        ensureSidePane: (workspaceKey, options) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }
          if (options?.focus !== false) {
            get().setSidePanelOpen(normalizedWorkspaceKey, true);
            return (
              getWorkspaceSidePane(
                getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey).root,
              )?.id ?? null
            );
          }

          const layout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const ensured = ensureSidePaneInLayout({ layout, createNodeId: ids.createNodeId });
          if (ensured.layout !== layout) {
            set((state) => ({
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: ensured.layout,
              },
            }));
          }
          return ensured.paneId;
        },
        closeTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            if (findSheet(state, normalizedWorkspaceKey, normalizedTabId)) {
              return withoutSheet(state, normalizedWorkspaceKey, normalizedTabId);
            }
            const nextLayout = closeTabInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        getTabDestination: (workspaceKey, tabId) => {
          const state = get();
          if (state.sheetsByWorkspace[workspaceKey]?.some((sheet) => sheet.tab.tabId === tabId)) {
            return { kind: "sheet", tabId };
          }
          const layout = state.layoutByWorkspace[workspaceKey];
          if (!layout) return null;
          const pane = findPaneContainingTab(layout.root, tabId);
          if (!pane) return null;
          return {
            kind: "pane",
            paneId: pane.id,
            host: pane.id === getWorkspaceSidePane(layout.root)?.id ? "side" : "main",
            tabId,
          };
        },
        focusTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            const currentLayout = getWorkspaceLayout(
              state.layoutByWorkspace,
              normalizedWorkspaceKey,
            );
            const nextLayout =
              focusTabInLayout({
                layout: currentLayout,
                tabId: normalizedTabId,
              }) ?? currentLayout;
            const reveal = revealSidePanelForFocus(state, normalizedWorkspaceKey, nextLayout);
            if (nextLayout === currentLayout && !reveal) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              ...reveal,
              // Choosing a tab dismisses the sheets that cover it.
              ...dismissSheets(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        selectTabInPane: (workspaceKey, paneId, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedPaneId || !normalizedTabId) {
            return;
          }
          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const nextLayout = selectTabInPaneInLayout({
              layout,
              paneId: normalizedPaneId,
              tabId: normalizedTabId,
            });
            return nextLayout
              ? {
                  // Choosing a tab dismisses the sheets that cover it.
                  ...dismissSheets(state, normalizedWorkspaceKey),
                  layoutByWorkspace: {
                    ...state.layoutByWorkspace,
                    [normalizedWorkspaceKey]: nextLayout,
                  },
                }
              : state;
          });
        },
        replaceTab: (workspaceKey, tabId, target, tabState) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedTarget) return null;
          if (findSheet(get(), normalizedWorkspaceKey, normalizedTabId)) {
            const policy = resolveCompactSheetPolicy(normalizedWorkspaceKey, normalizedTarget);
            const next: WorkspaceLayoutStore = {
              ...get(),
              ...withSheetTab(get(), normalizedWorkspaceKey, normalizedTabId, (sheet) => ({
                ...sheet,
                policy: policy ?? sheet.policy,
                tab: {
                  ...sheet.tab,
                  target: normalizedTarget,
                  ...(tabState !== undefined ? { state: tabState } : {}),
                },
              })),
            };
            if (policy) {
              set((state) => ({
                sheetsByWorkspace: next.sheetsByWorkspace,
                ...advancePanelRevision(
                  state,
                  normalizedWorkspaceKey,
                  normalizedTabId,
                  normalizedTarget,
                ),
              }));
              return normalizedTabId;
            }
            // A target sheets do not host becomes the tab it would have opened as.
            const promoted = openSheetTabInFront(
              next,
              normalizedWorkspaceKey,
              normalizedTabId,
              ids.createNodeId,
            );
            set(promoted?.patch ?? withoutSheet(next, normalizedWorkspaceKey, normalizedTabId));
            return promoted?.tabId ?? null;
          }
          const result = replaceTabTargetInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            target: normalizedTarget,
            createTabId: createWorkspaceTabInstanceId,
            state: tabState,
          });
          if (!result) return null;
          set((state) => ({
            ...withoutFocusRestoration(state, normalizedWorkspaceKey),
            ...advancePanelRevision(state, normalizedWorkspaceKey, result.tabId, normalizedTarget),
            hiddenAgentIdsByWorkspace:
              normalizedTarget.kind !== "agent"
                ? state.hiddenAgentIdsByWorkspace
                : removeAgentIdFromWorkspaceSet(
                    state.hiddenAgentIdsByWorkspace,
                    normalizedWorkspaceKey,
                    normalizedTarget.agentId,
                  ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));
          return result.tabId;
        },
        setTabState: (workspaceKey, tabId, tabState) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) return;
          set((state) => {
            if (findSheet(state, normalizedWorkspaceKey, normalizedTabId)) {
              return withSheetTab(state, normalizedWorkspaceKey, normalizedTabId, (sheet) => {
                const { state: _previous, ...tab } = sheet.tab;
                return {
                  ...sheet,
                  tab: tabState === undefined ? tab : { ...tab, state: tabState },
                };
              });
            }
            const layout = setTabStateInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
              state: tabState,
            });
            if (!layout) return state;
            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: layout,
              },
            };
          });
        },
        convertDraftToAgent: (workspaceKey, tabId, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedAgentId) {
            return null;
          }

          const result = convertDraftToAgentInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            agentId: normalizedAgentId,
          });
          if (!result) {
            return null;
          }

          set((state) => ({
            ...(result.layout.focusedPaneId !== null
              ? (withoutFocusRestoration(state, normalizedWorkspaceKey) ?? {})
              : {}),
            hiddenAgentIdsByWorkspace: removeAgentIdFromWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.tabId;
        },
        reconcileTabs: (workspaceKey, snapshot) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const rawLayout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const nextState = reconcileWorkspaceTabs(
              {
                layout: rawLayout,
                pinnedAgentIds: state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
                hiddenAgentIds: state.hiddenAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
              },
              snapshot,
              ids.createNodeId,
            );
            const nextLayout = nextState.layout;
            let pinnedAgentIdsByWorkspace = state.pinnedAgentIdsByWorkspace;
            for (const agentId of state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? []) {
              if (!nextState.pinnedAgentIds?.has(agentId)) {
                pinnedAgentIdsByWorkspace = removeAgentIdFromWorkspaceSet(
                  pinnedAgentIdsByWorkspace,
                  normalizedWorkspaceKey,
                  agentId,
                );
              }
            }
            const sheets = getSheets(state, normalizedWorkspaceKey);
            const fittingSheets = sheets.filter(
              (sheet) => !sheetAgentNoLongerFits(normalizedWorkspaceKey, sheet, snapshot),
            );
            const sheetAgentGone = fittingSheets.length !== sheets.length;
            if (
              state.layoutByWorkspace[normalizedWorkspaceKey] &&
              nextLayout === rawLayout &&
              pinnedAgentIdsByWorkspace === state.pinnedAgentIdsByWorkspace &&
              !sheetAgentGone
            ) {
              return state;
            }

            return {
              ...(sheetAgentGone ? withSheets(state, normalizedWorkspaceKey, fittingSheets) : {}),
              pinnedAgentIdsByWorkspace,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        reorderTabs: (workspaceKey, tabIds) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const nextLayout = reorderFocusedPaneTabsInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabIds,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        getWorkspaceTabs: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return [];
          }
          return collectAllTabs(
            getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey).root,
          );
        },
        setSidePanelOpen: (workspaceKey, open) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const isOpen = selectIsWorkspaceSidePanelOpen(state, normalizedWorkspaceKey);
            if (open) {
              // Opening reveals the panel and lands focus in it, creating an empty
              // side pane (the launcher) when the workspace has none yet.
              const ensured = ensureSidePaneInLayout({ layout, createNodeId: ids.createNodeId });
              const nextLayout =
                focusPaneInLayout({ layout: ensured.layout, paneId: ensured.paneId }) ??
                ensured.layout;
              if (isOpen && nextLayout === layout) {
                return state;
              }
              const { [normalizedWorkspaceKey]: _closed, ...sidePanelOpenByWorkspace } =
                state.sidePanelOpenByWorkspace;
              return {
                ...withoutFocusRestoration(state, normalizedWorkspaceKey),
                sidePanelOpenByWorkspace,
                layoutByWorkspace: {
                  ...state.layoutByWorkspace,
                  [normalizedWorkspaceKey]: nextLayout,
                },
              };
            }

            // Hiding keeps the panel's tabs, drops a side pane that holds none, and
            // moves focus back to the main pane so shortcuts keep acting on visible
            // tabs.
            const withoutEmptySidePane = removeEmptySidePaneInLayout(layout) ?? layout;
            const mainPaneId = getWorkspaceMainPane(withoutEmptySidePane.root).id;
            const nextLayout =
              focusPaneInLayout({ layout: withoutEmptySidePane, paneId: mainPaneId }) ??
              withoutEmptySidePane;
            if (!isOpen && nextLayout === layout) {
              return state;
            }
            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              sidePanelOpenByWorkspace: {
                ...state.sidePanelOpenByWorkspace,
                [normalizedWorkspaceKey]: false,
              },
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        toggleSidePanel: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }
          get().setSidePanelOpen(
            normalizedWorkspaceKey,
            !selectIsWorkspaceSidePanelOpen(get(), normalizedWorkspaceKey),
          );
        },
        moveTabToPane: (workspaceKey, tabId, toPaneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedToPaneId = trimNonEmpty(toPaneId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedToPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = moveTabToPaneInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
              toPaneId: normalizedToPaneId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              ...revealSidePanelForFocus(state, normalizedWorkspaceKey, nextLayout),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        closePane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = closePaneInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        focusPane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = focusPaneInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              ...revealSidePanelForFocus(state, normalizedWorkspaceKey, nextLayout),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        unfocusPane: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }

          const token = ids.createFocusRestorationToken();
          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const currentRestoration = state.focusRestorationByWorkspace[normalizedWorkspaceKey];
            const restorePaneId = currentRestoration?.restorePaneId ?? layout.focusedPaneId;

            return {
              focusRestorationByWorkspace: {
                ...state.focusRestorationByWorkspace,
                [normalizedWorkspaceKey]: {
                  restorePaneId,
                  tokens: [...(currentRestoration?.tokens ?? []), token],
                },
              },
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]:
                  layout.focusedPaneId === null ? layout : { ...layout, focusedPaneId: null },
              },
            };
          });
          return token;
        },
        restorePaneFocus: (workspaceKey, token) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedToken = trimNonEmpty(token);
          if (!normalizedWorkspaceKey || !normalizedToken) {
            return;
          }

          set((state) => {
            const restoration = state.focusRestorationByWorkspace[normalizedWorkspaceKey];
            if (!restoration?.tokens.includes(normalizedToken)) {
              return state;
            }

            const nextTokens = restoration.tokens.filter((entry) => entry !== normalizedToken);
            const { [normalizedWorkspaceKey]: _removed, ...remainingRestorations } =
              state.focusRestorationByWorkspace;
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);

            if (layout.focusedPaneId !== null) {
              return {
                focusRestorationByWorkspace: remainingRestorations,
              };
            }

            if (nextTokens.length > 0) {
              return {
                focusRestorationByWorkspace: {
                  ...remainingRestorations,
                  [normalizedWorkspaceKey]: {
                    restorePaneId: restoration.restorePaneId,
                    tokens: nextTokens,
                  },
                },
              };
            }

            const restorePane = findPaneById(layout.root, restoration.restorePaneId);
            // A hidden side panel never takes focus back; the chat does instead.
            const restoresIntoHiddenSidePanel =
              restorePane !== null &&
              restorePane.id === getWorkspaceSidePane(layout.root)?.id &&
              !selectIsWorkspaceSidePanelOpen(state, normalizedWorkspaceKey);
            const restorePaneId = restoresIntoHiddenSidePanel
              ? getWorkspaceMainPane(layout.root).id
              : (restorePane?.id ?? null);
            if (!restorePaneId) {
              return {
                focusRestorationByWorkspace: remainingRestorations,
              };
            }

            return {
              focusRestorationByWorkspace: remainingRestorations,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: {
                  ...layout,
                  focusedPaneId: restorePaneId,
                },
              },
            };
          });
        },
        resizeSplit: (workspaceKey, groupId, sizes) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedGroupId = trimNonEmpty(groupId);
          if (!normalizedWorkspaceKey || !normalizedGroupId) {
            return;
          }

          set((state) => ({
            splitSizesByWorkspace: {
              ...state.splitSizesByWorkspace,
              [normalizedWorkspaceKey]: {
                ...state.splitSizesByWorkspace[normalizedWorkspaceKey],
                [normalizedGroupId]: clampNormalizedSizes(sizes),
              },
            },
          }));
        },
        reorderTabsInPane: (workspaceKey, paneId, tabIds) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = reorderPaneTabsInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
              tabIds,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        unpinAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const currentPinnedAgentIds =
              state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null;
            if (!currentPinnedAgentIds?.has(normalizedAgentId)) {
              return state;
            }

            if (currentPinnedAgentIds.size === 1) {
              const nextPinnedAgentIdsByWorkspace = {
                ...state.pinnedAgentIdsByWorkspace,
              };
              delete nextPinnedAgentIdsByWorkspace[normalizedWorkspaceKey];
              return {
                pinnedAgentIdsByWorkspace: nextPinnedAgentIdsByWorkspace,
              };
            }

            const nextPinnedAgentIds = new Set(currentPinnedAgentIds);
            nextPinnedAgentIds.delete(normalizedAgentId);

            return {
              pinnedAgentIdsByWorkspace: {
                ...state.pinnedAgentIdsByWorkspace,
                [normalizedWorkspaceKey]: nextPinnedAgentIds,
              },
            };
          });
        },
        hideAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const nextHiddenAgentIdsByWorkspace = addAgentIdToWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            );
            if (nextHiddenAgentIdsByWorkspace === state.hiddenAgentIdsByWorkspace) {
              return state;
            }

            return {
              hiddenAgentIdsByWorkspace: nextHiddenAgentIdsByWorkspace,
            };
          });
        },
        unhideAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const nextHiddenAgentIdsByWorkspace = removeAgentIdFromWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            );
            if (nextHiddenAgentIdsByWorkspace === state.hiddenAgentIdsByWorkspace) {
              return state;
            }

            return {
              hiddenAgentIdsByWorkspace: nextHiddenAgentIdsByWorkspace,
            };
          });
        },
        purgeWorkspace: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const hasAny =
              normalizedWorkspaceKey in state.pendingOpenByWorkspace ||
              normalizedWorkspaceKey in state.layoutByWorkspace ||
              normalizedWorkspaceKey in state.splitSizesByWorkspace ||
              normalizedWorkspaceKey in state.sidePanelOpenByWorkspace ||
              normalizedWorkspaceKey in state.pinnedAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.hiddenAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.focusRestorationByWorkspace ||
              normalizedWorkspaceKey in state.pullRequestTabAutoOpenedByWorkspace ||
              normalizedWorkspaceKey in state.sheetsByWorkspace;
            if (!hasAny) {
              return state;
            }
            const { [normalizedWorkspaceKey]: _pendingOpen, ...pendingOpenByWorkspace } =
              state.pendingOpenByWorkspace;
            const {
              [normalizedWorkspaceKey]: _autoOpened,
              ...pullRequestTabAutoOpenedByWorkspace
            } = state.pullRequestTabAutoOpenedByWorkspace;
            const { [normalizedWorkspaceKey]: _layout, ...layoutByWorkspace } =
              state.layoutByWorkspace;
            const { [normalizedWorkspaceKey]: _splits, ...splitSizesByWorkspace } =
              state.splitSizesByWorkspace;
            const { [normalizedWorkspaceKey]: _sidePanel, ...sidePanelOpenByWorkspace } =
              state.sidePanelOpenByWorkspace;
            const { [normalizedWorkspaceKey]: _pinned, ...pinnedAgentIdsByWorkspace } =
              state.pinnedAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _hidden, ...hiddenAgentIdsByWorkspace } =
              state.hiddenAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _restoration, ...focusRestorationByWorkspace } =
              state.focusRestorationByWorkspace;
            return {
              ...withSheets(state, normalizedWorkspaceKey, NO_SHEETS),
              pendingOpenByWorkspace,
              pullRequestTabAutoOpenedByWorkspace,
              layoutByWorkspace,
              splitSizesByWorkspace,
              sidePanelOpenByWorkspace,
              pinnedAgentIdsByWorkspace,
              hiddenAgentIdsByWorkspace,
              focusRestorationByWorkspace,
            };
          });
        },
      }),
      {
        name: "workspace-layout-state",
        version: WORKSPACE_LAYOUT_PERSIST_VERSION,
        storage: createValidatedPersistStorage(storage, WorkspaceLayoutPersistedStateSchema, {
          skipUnchanged: true,
        }),
        migrate: (persistedState) => migrateWorkspaceLayoutPersistedState(persistedState),
        partialize: createPersistedStateProjection(),
        merge: (persistedState, currentState) => {
          const result = WorkspaceLayoutPersistedStateSchema.safeParse(persistedState);
          if (!result.success) {
            return currentState;
          }
          const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
          for (const [workspaceKey, persistedLayout] of Object.entries(
            result.data.layoutByWorkspace,
          )) {
            layoutByWorkspace[workspaceKey] = restoreWorkspaceLayout(persistedLayout);
          }
          return {
            ...currentState,
            layoutByWorkspace,
            pinnedAgentIdsByWorkspace: Object.fromEntries(
              Object.entries(result.data.pinnedAgentIdsByWorkspace ?? {}).map(([key, agentIds]) => [
                key,
                new Set(agentIds),
              ]),
            ),
            splitSizesByWorkspace: result.data.splitSizesByWorkspace ?? {},
            sidePanelOpenByWorkspace: result.data.sidePanelOpenByWorkspace ?? {},
            pullRequestTabAutoOpenedByWorkspace:
              result.data.pullRequestTabAutoOpenedByWorkspace ?? {},
          };
        },
      },
    ),
  );
}

export const useWorkspaceLayoutStore = createWorkspaceLayoutStore();

/**
 * The agent tabs that exist right now, including sheet tabs, across every workspace of this host,
 * independently of which workspace views are mounted. Timeline sync uses this to release a chat
 * when its tab closes. It is not a subscription source: this layout is restored from disk at
 * launch, so subscribing to it would resume every agent the user has ever opened.
 */
export function observeOpenWorkspaceAgentIds(
  serverId: string,
  listener: (agentIds: string[]) => void,
  store = useWorkspaceLayoutStore,
): () => void {
  let previous: string[] | undefined;
  const publish = (
    state: Pick<WorkspaceLayoutStore, "layoutByWorkspace" | "sheetsByWorkspace">,
  ) => {
    const ids = new Set<string>();
    const tabsByWorkspace = [
      ...Object.entries(state.layoutByWorkspace).map(
        ([workspaceKey, layout]) => [workspaceKey, collectAllTabs(layout.root)] as const,
      ),
      ...Object.entries(state.sheetsByWorkspace).map(
        ([workspaceKey, sheets]) => [workspaceKey, sheets.map((sheet) => sheet.tab)] as const,
      ),
    ];
    for (const [workspaceKey, tabs] of tabsByWorkspace) {
      if (!workspaceKey.startsWith(`${serverId}:`)) continue;
      for (const tab of tabs) {
        if (tab.target.kind === "agent") ids.add(tab.target.agentId);
      }
    }
    const next = [...ids].sort();
    if (previous?.length === next.length && previous.every((id, index) => id === next[index]))
      return;
    previous = next;
    listener(next);
  };
  const unsubscribe = store.subscribe((state, before) => {
    if (
      state.layoutByWorkspace !== before.layoutByWorkspace ||
      state.sheetsByWorkspace !== before.sheetsByWorkspace
    ) {
      publish(state);
    }
  });
  publish(store.getState());
  return unsubscribe;
}

export function useWorkspaceLayoutStoreHydrated(): boolean {
  const [hasHydrated, setHasHydrated] = useState(() =>
    useWorkspaceLayoutStore.persist.hasHydrated(),
  );

  useEffect(() => {
    if (useWorkspaceLayoutStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }

    return useWorkspaceLayoutStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
  }, []);

  return hasHydrated;
}

interface PendingWorkspaceOpenReadiness {
  workspaceKey: string | null;
  hasHydratedWorkspaces: boolean;
  workspaceExists: boolean;
  onOpened: (workspaceKey: string, tabId: string | null) => void;
}

export function usePendingWorkspaceOpen({
  workspaceKey,
  hasHydratedWorkspaces,
  workspaceExists,
  onOpened,
}: PendingWorkspaceOpenReadiness): WorkspaceTabTarget | null {
  const workspaceReady = hasHydratedWorkspaces && workspaceExists;
  const pending = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.pendingOpenByWorkspace[workspaceKey] : undefined,
  );
  const layoutHydrated = useWorkspaceLayoutStoreHydrated();
  useLayoutEffect(() => {
    if (workspaceKey && workspaceReady && layoutHydrated && pending) {
      onOpened(workspaceKey, useWorkspaceLayoutStore.getState().consumePendingOpen(workspaceKey));
    }
  }, [workspaceKey, workspaceReady, layoutHydrated, pending, onOpened]);
  return pending ? pending.target : null;
}
