import invariant from "tiny-invariant";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { MIN_SPLIT_SIZE } from "@/stores/workspace-layout-constants";
import { defaultWorkspaceLayoutIds } from "@/stores/workspace-layout-ids";
import type { WorkspaceLayoutNodeIdPrefix } from "@/stores/workspace-layout-ids";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";

export interface SplitPane {
  id: string;
  tabIds: string[];
  focusedTabId: string | null;
}

export interface SplitGroup {
  id: string;
  direction: "horizontal" | "vertical";
  children: SplitNode[];
  sizes: number[];
}

export type SplitNode = { kind: "pane"; pane: SplitPane } | { kind: "group"; group: SplitGroup };

export interface WorkspaceLayout {
  root: SplitNode;
  focusedPaneId: string | null;
  parentTabIdByTabId?: Record<string, string>;
}

interface SplitPaneInternal extends SplitPane {
  tabs: WorkspaceTab[];
}

interface SplitGroupInternal extends Omit<SplitGroup, "children"> {
  children: SplitNodeInternal[];
}

type SplitNodeInternal =
  | { kind: "pane"; pane: SplitPaneInternal }
  | { kind: "group"; group: SplitGroupInternal };

interface NormalizeSizesInput {
  sizes: number[];
  count: number;
}

interface ReorderTabsForPaneInput {
  pane: SplitPaneInternal;
  tabIds: string[];
}

interface UpdateGroupSizesInTreeInput {
  groupId: string;
  sizes: number[];
}

interface UpdatePaneInTreeInput {
  paneId: string;
  updater: (pane: SplitPaneInternal) => SplitPaneInternal;
}

interface DetachTabFromTreeInput {
  tabId: string;
  preserveEmptyPaneId?: string | null;
}

interface DetachTabFromTreeResult {
  root: SplitNodeInternal;
  tab: WorkspaceTab | null;
  sourcePaneId: string | null;
}

interface InsertTabIntoPaneInput {
  paneId: string;
  tab: WorkspaceTab;
  focusTabId?: string | null;
}

interface OpenTabInLayoutInput {
  layout: WorkspaceLayout;
  target: WorkspaceTabTarget;
  now: number;
  createNodeId?: (prefix: WorkspaceLayoutNodeIdPrefix) => string;
}

interface OpenTabInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface RetargetTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  target: WorkspaceTabTarget;
}

interface RetargetTabInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface ConvertDraftToAgentInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  agentId: string;
}

interface ConvertDraftToAgentInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface ReorderFocusedPaneTabsInLayoutInput {
  layout: WorkspaceLayout;
  tabIds: string[];
}

interface CloseTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
}

interface EnsureSidePaneInLayoutInput {
  layout: WorkspaceLayout;
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string;
}

interface EnsureSidePaneInLayoutResult {
  layout: WorkspaceLayout;
  paneId: string;
}

interface MoveTabToPaneInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  toPaneId: string;
}

interface FocusTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
}

interface FocusPaneInLayoutInput {
  layout: WorkspaceLayout;
  paneId: string;
}

interface ResizeSplitInLayoutInput {
  layout: WorkspaceLayout;
  groupId: string;
  sizes: number[];
}

interface ReorderPaneTabsInLayoutInput {
  layout: WorkspaceLayout;
  paneId: string;
  tabIds: string[];
}

export interface WorkspaceTabReconcileState {
  layout: WorkspaceLayout;
  pinnedAgentIds?: ReadonlySet<string> | null;
  pendingAgentIds?: ReadonlySet<string> | null;
  hiddenAgentIds?: ReadonlySet<string> | null;
}

export interface WorkspaceTabSnapshot {
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  activeAgentIds: Iterable<string>;
  autoOpenAgentIds: Iterable<string>;
  knownAgentIds: Iterable<string>;
  knownTerminalIds?: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate?: boolean;
}

const DEFAULT_PANE_ID = "main";

/**
 * Share of the workspace the side panel takes when it first appears. A
 * persisted resize wins over it afterwards.
 */
export const SIDE_PANE_DEFAULT_SIZE = 0.42;

const SIDE_PANEL_TAB_KINDS: ReadonlySet<WorkspaceTabTarget["kind"]> = new Set<
  WorkspaceTabTarget["kind"]
>([
  "provider_subagent",
  "setup",
  "terminal",
  "arena_terminal",
  "browser",
  "file",
  "working_diff",
  "commit_diff",
  "changes",
  "files",
  "pull_request",
]);

/**
 * Whether a tab opens in the side panel. The chat (a draft or an agent) is the
 * main pane; everything it works alongside, subagent transcripts and workspace
 * setup included, opens to its right. A tab can still be dragged to the other
 * pane afterwards.
 */
export function isSidePanelTabTarget(target: WorkspaceTabTarget): boolean {
  return SIDE_PANEL_TAB_KINDS.has(target.kind);
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTabIds(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const tabId = trimNonEmpty(typeof value === "string" ? value : null);
    if (!tabId || seen.has(tabId)) {
      continue;
    }
    seen.add(tabId);
    next.push(tabId);
  }
  return next;
}

function createPaneNode(input: {
  id: string;
  tabs?: WorkspaceTab[];
  focusedTabId?: string | null;
}): SplitNodeInternal {
  const normalizedTabs = normalizeWorkspaceTabs(input.tabs ?? []);
  const tabIds = normalizedTabs.map((tab) => tab.tabId);
  const focusedTabId = tabIds.includes(input.focusedTabId ?? "")
    ? (input.focusedTabId ?? null)
    : (tabIds[tabIds.length - 1] ?? null);

  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabs: normalizedTabs,
      tabIds,
      focusedTabId,
    },
  };
}

function createGroupNode(input: {
  id: string;
  direction: "horizontal" | "vertical";
  children: SplitNodeInternal[];
  sizes?: number[];
}): SplitNodeInternal {
  return {
    kind: "group",
    group: {
      id: input.id,
      direction: input.direction,
      children: input.children,
      sizes: normalizeSizes({
        sizes: input.sizes ?? input.children.map(() => 1 / Math.max(input.children.length, 1)),
        count: input.children.length,
      }),
    },
  };
}

function normalizeWorkspaceTab(value: unknown): WorkspaceTab | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const tab = value as WorkspaceTab;
  const target = normalizeWorkspaceTabTarget(tab.target);
  if (!target) {
    return null;
  }
  const tabId =
    target.kind === "working_diff"
      ? buildDeterministicWorkspaceTabId(target)
      : (trimNonEmpty(tab.tabId) ?? buildDeterministicWorkspaceTabId(target));
  if (!tabId) {
    return null;
  }

  return {
    tabId,
    target,
    createdAt: typeof tab.createdAt === "number" ? tab.createdAt : Date.now(),
  };
}

function normalizeWorkspaceTabs(input: unknown): WorkspaceTab[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const next: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const tab = normalizeWorkspaceTab(value);
    if (!tab || seen.has(tab.tabId)) {
      continue;
    }
    seen.add(tab.tabId);
    next.push(tab);
  }
  return next;
}

function normalizeSizes(input: NormalizeSizesInput): number[] {
  if (input.count <= 0) {
    return [];
  }

  const raw = input.sizes.slice(0, input.count);
  while (raw.length < input.count) {
    raw.push(1);
  }

  const sanitized = raw.map((value) => (Number.isFinite(value) && value > 0 ? value : 1));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: input.count }, () => 1 / input.count);
  }
  return sanitized.map((value) => value / total);
}

export function clampNormalizedSizes(sizes: number[]): number[] {
  if (sizes.length === 0) {
    return [];
  }

  const normalized = normalizeSizes({ sizes, count: sizes.length });
  if (sizes.length === 1) {
    return [1];
  }
  if (sizes.length * MIN_SPLIT_SIZE > 1) {
    return Array.from({ length: sizes.length }, () => 1 / sizes.length);
  }

  const nextSizes = Array.from({ length: sizes.length }, () => 0);
  const unlocked = new Set(normalized.map((_, index) => index));
  let remainingTotal = 1;

  while (unlocked.size > 0) {
    let unlockedWeight = 0;
    for (const index of unlocked) {
      unlockedWeight += normalized[index] ?? 0;
    }

    if (unlockedWeight <= 0) {
      const evenShare = remainingTotal / unlocked.size;
      for (const index of unlocked) {
        nextSizes[index] = evenShare;
      }
      break;
    }

    const nextLocked: number[] = [];
    for (const index of unlocked) {
      const proposedSize = ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      if (proposedSize < MIN_SPLIT_SIZE) {
        nextLocked.push(index);
      }
    }

    if (nextLocked.length === 0) {
      for (const index of unlocked) {
        nextSizes[index] = ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      }
      break;
    }

    for (const index of nextLocked) {
      nextSizes[index] = MIN_SPLIT_SIZE;
      unlocked.delete(index);
      remainingTotal -= MIN_SPLIT_SIZE;
    }
  }

  return normalizeSizes({ sizes: nextSizes, count: nextSizes.length });
}

function asInternalNode(node: SplitNode): SplitNodeInternal {
  return node as SplitNodeInternal;
}

function asInternalLayout(layout: WorkspaceLayout): {
  root: SplitNodeInternal;
  focusedPaneId: string | null;
} {
  return layout as { root: SplitNodeInternal; focusedPaneId: string | null };
}

function findPanePathById(
  node: SplitNodeInternal,
  paneId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return node.pane.id === paneId ? path : null;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findPanePathById(node.group.children[index], paneId, [...path, index]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function findPanePathContainingTab(
  node: SplitNodeInternal,
  tabId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return node.pane.tabs.some((tab) => tab.tabId === tabId) ? path : null;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findPanePathContainingTab(node.group.children[index], tabId, [
      ...path,
      index,
    ]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function findGroupPathById(
  node: SplitNodeInternal,
  groupId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return null;
  }
  if (node.group.id === groupId) {
    return path;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findGroupPathById(node.group.children[index], groupId, [...path, index]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function getNodeAtPath(node: SplitNodeInternal, path: number[]): SplitNodeInternal {
  let current = node;
  for (const index of path) {
    invariant(current.kind === "group", "Expected group while traversing split tree");
    current = current.group.children[index];
  }
  return current;
}

function replaceNodeAtPath(
  node: SplitNodeInternal,
  path: number[],
  updater: (node: SplitNodeInternal) => SplitNodeInternal,
): SplitNodeInternal {
  if (path.length === 0) {
    return updater(node);
  }

  invariant(node.kind === "group", "Expected group while replacing split tree node");
  const [index, ...rest] = path;
  const nextChildren = node.group.children.map((child, childIndex) =>
    childIndex === index ? replaceNodeAtPath(child, rest, updater) : child,
  );

  return createGroupNode({
    id: node.group.id,
    direction: node.group.direction,
    children: nextChildren,
    sizes: node.group.sizes,
  });
}

function collectInternalPanes(node: SplitNodeInternal): SplitPaneInternal[] {
  if (node.kind === "pane") {
    return [node.pane];
  }
  return node.group.children.flatMap((child) => collectInternalPanes(child));
}

function getMainPaneInternal(root: SplitNodeInternal): SplitPaneInternal {
  const pane = collectInternalPanes(root)[0];
  invariant(pane, "Workspace layout must always have a pane");
  return pane;
}

function getSidePaneInternal(root: SplitNodeInternal): SplitPaneInternal | null {
  if (root.kind !== "group") {
    return null;
  }
  const side = root.group.children[1];
  return side?.kind === "pane" ? side.pane : null;
}

function ensureSidePaneInternal(
  root: SplitNodeInternal,
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string,
): { root: SplitNodeInternal; paneId: string } {
  const existing = getSidePaneInternal(root);
  if (existing) {
    return { root, paneId: existing.id };
  }
  const paneId = createNodeId("pane");
  return {
    root: createGroupNode({
      id: createNodeId("group"),
      direction: "horizontal",
      children: [root, createPaneNode({ id: paneId })],
      sizes: [1 - SIDE_PANE_DEFAULT_SIZE, SIDE_PANE_DEFAULT_SIZE],
    }),
    paneId,
  };
}

/**
 * The layout is a main pane with an optional side pane to its right: a bare
 * pane, or a horizontal group of exactly two panes. Anything else (older
 * free-form splits) is flattened into that shape, chats to the main pane and
 * side-panel tabs to the side pane, in tree order.
 */
function canonicalizeLayoutShape(root: SplitNodeInternal): SplitNodeInternal {
  if (root.kind === "pane") {
    return root;
  }
  const { children, direction } = root.group;
  if (
    direction === "horizontal" &&
    children.length === 2 &&
    children.every((child) => child.kind === "pane")
  ) {
    return root;
  }

  const panes = collectInternalPanes(root);
  const mainTabs: WorkspaceTab[] = [];
  const sideTabs: WorkspaceTab[] = [];
  let mainFocusedTabId: string | null = null;
  let sideFocusedTabId: string | null = null;
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      const isSide = isSidePanelTabTarget(tab.target);
      (isSide ? sideTabs : mainTabs).push(tab);
      if (tab.tabId !== pane.focusedTabId) {
        continue;
      }
      if (isSide) {
        sideFocusedTabId ??= tab.tabId;
      } else {
        mainFocusedTabId ??= tab.tabId;
      }
    }
  }

  const mainId = panes[0]?.id ?? DEFAULT_PANE_ID;
  const main = createPaneNode({ id: mainId, tabs: mainTabs, focusedTabId: mainFocusedTabId });
  if (sideTabs.length === 0) {
    return main;
  }
  const sideId = panes.find((pane) => pane.id !== mainId)?.id ?? `${mainId}_side`;
  return createGroupNode({
    id: root.group.id,
    direction: "horizontal",
    children: [
      main,
      createPaneNode({ id: sideId, tabs: sideTabs, focusedTabId: sideFocusedTabId }),
    ],
    sizes: [1 - SIDE_PANE_DEFAULT_SIZE, SIDE_PANE_DEFAULT_SIZE],
  });
}

function listPaneIds(node: SplitNodeInternal): string[] {
  if (node.kind === "pane") {
    return [node.pane.id];
  }
  const next: string[] = [];
  for (const child of node.group.children) {
    next.push(...listPaneIds(child));
  }
  return next;
}

function findNearestSiblingPaneId(root: SplitNodeInternal, paneId: string): string | null {
  const path = findPanePathById(root, paneId);
  if (!path || path.length === 0) {
    return null;
  }

  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    const childIndex = path[depth];
    const parentNode = getNodeAtPath(root, parentPath);
    invariant(parentNode.kind === "group", "Expected parent group for pane lookup");

    for (let index = childIndex - 1; index >= 0; index -= 1) {
      const paneIds = listPaneIds(parentNode.group.children[index]);
      if (paneIds.length > 0) {
        return paneIds[paneIds.length - 1] ?? null;
      }
    }

    for (let index = childIndex + 1; index < parentNode.group.children.length; index += 1) {
      const paneIds = listPaneIds(parentNode.group.children[index]);
      if (paneIds.length > 0) {
        return paneIds[0] ?? null;
      }
    }
  }

  return null;
}

function normalizePaneAfterTabChange(pane: SplitPaneInternal): SplitPaneInternal {
  const tabs = normalizeWorkspaceTabs(pane.tabs);
  const tabIds = tabs.map((tab) => tab.tabId);
  const focusedTabId = tabIds.includes(pane.focusedTabId ?? "")
    ? pane.focusedTabId
    : (tabIds[tabIds.length - 1] ?? null);

  return {
    id: pane.id,
    tabs,
    tabIds,
    focusedTabId,
  };
}

function normalizePaneNode(rawPane: SplitPaneInternal | undefined): SplitNodeInternal | null {
  const paneId = trimNonEmpty(rawPane?.id);
  if (!paneId) {
    return null;
  }
  const tabs = normalizeWorkspaceTabs(rawPane?.tabs);
  const tabIds = normalizeTabIds(rawPane?.tabIds);
  const mergedTabs =
    tabs.length > 0
      ? tabs
      : tabIds.map((tabId) => ({
          tabId,
          target: { kind: "draft", draftId: tabId } as WorkspaceTabTarget,
          createdAt: Date.now(),
        }));
  return createPaneNode({
    id: paneId,
    tabs: mergedTabs,
    focusedTabId: trimNonEmpty(rawPane?.focusedTabId) ?? null,
  });
}

function normalizeGroupNode(rawGroup: SplitGroupInternal | undefined): SplitNodeInternal | null {
  if (!rawGroup) {
    return null;
  }
  const groupId = trimNonEmpty(rawGroup?.id);
  const direction = rawGroup?.direction;
  if (!groupId || (direction !== "horizontal" && direction !== "vertical")) {
    return null;
  }

  const children = Array.isArray(rawGroup.children)
    ? rawGroup.children
        .map((child) => normalizeNode(child))
        .filter((child): child is SplitNodeInternal => child !== null)
    : [];
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0] ?? null;
  }

  return createGroupNode({
    id: groupId,
    direction,
    children,
    sizes: Array.isArray(rawGroup.sizes) ? rawGroup.sizes : [],
  });
}

function normalizeNode(node: unknown): SplitNodeInternal | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  if ((node as SplitNode).kind === "pane") {
    return normalizePaneNode((node as { pane?: SplitPaneInternal }).pane);
  }

  if ((node as SplitNode).kind === "group") {
    return normalizeGroupNode((node as { group?: SplitGroupInternal }).group);
  }

  return null;
}

function reorderTabsForPane(input: ReorderTabsForPaneInput): SplitPaneInternal {
  const nextIds = normalizeTabIds(input.tabIds);
  const byId = new Map(input.pane.tabs.map((tab) => [tab.tabId, tab]));
  const reordered: WorkspaceTab[] = [];
  const seen = new Set<string>();

  for (const tabId of nextIds) {
    const tab = byId.get(tabId);
    if (!tab || seen.has(tabId)) {
      continue;
    }
    seen.add(tabId);
    reordered.push(tab);
  }

  for (const tab of input.pane.tabs) {
    if (seen.has(tab.tabId)) {
      continue;
    }
    seen.add(tab.tabId);
    reordered.push(tab);
  }

  return normalizePaneAfterTabChange({
    ...input.pane,
    tabs: reordered,
  });
}

function removePaneByPath(root: SplitNodeInternal, path: number[]): SplitNodeInternal {
  if (path.length === 0) {
    invariant(root.kind === "pane", "Expected pane at root while removing pane");
    return createPaneNode({ id: root.pane.id });
  }

  const parentPath = path.slice(0, -1);
  const removeIndex = path[path.length - 1];
  const parentNode = getNodeAtPath(root, parentPath);
  invariant(parentNode.kind === "group", "Expected parent group while removing pane");

  const nextParentChildren = parentNode.group.children.filter((_, index) => index !== removeIndex);
  invariant(nextParentChildren.length > 0, "Split tree cannot remove the final pane");

  const nextParentNode =
    nextParentChildren.length === 1
      ? nextParentChildren[0]
      : createGroupNode({
          id: parentNode.group.id,
          direction: parentNode.group.direction,
          children: nextParentChildren,
          sizes: parentNode.group.sizes.filter((_, index) => index !== removeIndex),
        });

  return replaceNodeAtPath(root, parentPath, () => nextParentNode);
}

function detachTabFromTree(
  root: SplitNodeInternal,
  input: DetachTabFromTreeInput,
): DetachTabFromTreeResult {
  const panePath = findPanePathContainingTab(root, input.tabId);
  if (!panePath) {
    return { root, tab: null, sourcePaneId: null };
  }

  const paneNode = getNodeAtPath(root, panePath);
  invariant(paneNode.kind === "pane", "Expected pane while detaching tab");
  const tab = paneNode.pane.tabs.find((entry) => entry.tabId === input.tabId) ?? null;
  if (!tab) {
    return { root, tab: null, sourcePaneId: paneNode.pane.id };
  }

  const nextPane = normalizePaneAfterTabChange({
    ...paneNode.pane,
    tabs: paneNode.pane.tabs.filter((entry) => entry.tabId !== input.tabId),
  });

  const nextRoot = replaceNodeAtPath(root, panePath, () => ({ kind: "pane", pane: nextPane }));
  if (nextPane.tabs.length > 0 || nextPane.id === input.preserveEmptyPaneId) {
    return { root: nextRoot, tab, sourcePaneId: paneNode.pane.id };
  }

  return {
    root: removePaneByPath(nextRoot, panePath),
    tab,
    sourcePaneId: paneNode.pane.id,
  };
}

function insertTabIntoPane(
  root: SplitNodeInternal,
  input: InsertTabIntoPaneInput,
): SplitNodeInternal {
  const panePath = findPanePathById(root, input.paneId);
  invariant(panePath, `Pane not found: ${input.paneId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while inserting tab");
    const existingIndex = node.pane.tabs.findIndex((tab) => tab.tabId === input.tab.tabId);
    const nextTabs =
      existingIndex >= 0
        ? node.pane.tabs.map((tab, index) => (index === existingIndex ? input.tab : tab))
        : [...node.pane.tabs, input.tab];
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        tabs: nextTabs,
        focusedTabId: input.focusTabId ?? input.tab.tabId,
      }),
    };
  });
}

function focusTabInPane(root: SplitNodeInternal, paneId: string, tabId: string): SplitNodeInternal {
  const panePath = findPanePathById(root, paneId);
  invariant(panePath, `Pane not found: ${paneId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while focusing tab");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        focusedTabId: tabId,
      }),
    };
  });
}

function replaceTabInTree(
  root: SplitNodeInternal,
  input: {
    tabId: string;
    nextTabId: string;
    target: WorkspaceTabTarget;
  },
): SplitNodeInternal {
  const panePath = findPanePathContainingTab(root, input.tabId);
  invariant(panePath, `Tab not found: ${input.tabId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while replacing tab");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        tabs: node.pane.tabs.map((tab) =>
          tab.tabId === input.tabId
            ? {
                ...tab,
                tabId: input.nextTabId,
                target: input.target,
              }
            : tab,
        ),
        focusedTabId:
          node.pane.focusedTabId === input.tabId ? input.nextTabId : node.pane.focusedTabId,
      }),
    };
  });
}

function updateGroupSizesInTree(
  root: SplitNodeInternal,
  input: UpdateGroupSizesInTreeInput,
): SplitNodeInternal {
  const groupPath = findGroupPathById(root, input.groupId);
  if (!groupPath) {
    return root;
  }
  return replaceNodeAtPath(root, groupPath, (node) => {
    invariant(node.kind === "group", "Expected group while resizing split");
    if (input.sizes.length !== node.group.children.length) {
      return node;
    }
    return createGroupNode({
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children,
      sizes: clampNormalizedSizes(input.sizes),
    });
  });
}

function updatePaneInTree(
  root: SplitNodeInternal,
  input: UpdatePaneInTreeInput,
): SplitNodeInternal {
  const panePath = findPanePathById(root, input.paneId);
  if (!panePath) {
    return root;
  }
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while updating pane");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange(input.updater(node.pane)),
    };
  });
}

export function normalizeLayout(layout: unknown): WorkspaceLayout {
  if (!layout || typeof layout !== "object") {
    return createDefaultLayout();
  }

  const rawLayout = layout as WorkspaceLayout;
  const root = canonicalizeLayoutShape(
    normalizeNode(rawLayout.root) ?? asInternalNode(createDefaultLayout().root),
  );
  const focusedPaneId =
    rawLayout.focusedPaneId === null ? null : trimNonEmpty(rawLayout.focusedPaneId);
  const resolvedFocusedPaneId =
    focusedPaneId === null
      ? null
      : ((focusedPaneId && findPaneById(root, focusedPaneId)?.id) ??
        collectAllPanes(root)[0]?.id ??
        DEFAULT_PANE_ID);

  const normalizedLayout = {
    root,
    focusedPaneId: resolvedFocusedPaneId,
  };
  const parentTabIdByTabId = normalizeParentTabMap({
    raw: rawLayout.parentTabIdByTabId,
    openTabIds: new Set(collectAllTabs(root).map((tab) => tab.tabId)),
  });

  return parentTabIdByTabId ? { ...normalizedLayout, parentTabIdByTabId } : normalizedLayout;
}

export function findPaneById(root: SplitNode, paneId: string | null | undefined): SplitPane | null {
  if (!paneId) {
    return null;
  }
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.id === paneId ? internalRoot.pane : null;
  }
  for (const child of internalRoot.group.children) {
    const pane = findPaneById(child, paneId);
    if (pane) {
      return pane;
    }
  }
  return null;
}

export function findPaneContainingTab(root: SplitNode, tabId: string): SplitPane | null {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.tabs.some((tab) => tab.tabId === tabId) ? internalRoot.pane : null;
  }
  for (const child of internalRoot.group.children) {
    const pane = findPaneContainingTab(child, tabId);
    if (pane) {
      return pane;
    }
  }
  return null;
}

/** The pane chats live in: the root pane, or the left child of the root split. */
export function getWorkspaceMainPane(root: SplitNode): SplitPane {
  return getMainPaneInternal(asInternalNode(root));
}

/** The side panel's pane, when the layout has one. */
export function getWorkspaceSidePane(root: SplitNode): SplitPane | null {
  return getSidePaneInternal(asInternalNode(root));
}

export function collectAllTabs(root: SplitNode): WorkspaceTab[] {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.tabs.slice();
  }
  return internalRoot.group.children.flatMap((child) => collectAllTabs(child));
}

export function collectAllPanes(root: SplitNode): SplitPane[] {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return [internalRoot.pane];
  }
  return internalRoot.group.children.flatMap((child) => collectAllPanes(child));
}

function isEphemeralTab(tab: WorkspaceTab): boolean {
  // Commit diff tabs are ephemeral: their SHA may be rebased away before the next
  // load, so a restored tab could point at a dead commit.
  return tab.target.kind === "commit_diff";
}

function stripEphemeralTabsFromNode(node: SplitNodeInternal): SplitNodeInternal {
  if (node.kind === "pane") {
    const nextTabs = node.pane.tabs.filter((tab) => !isEphemeralTab(tab));
    if (nextTabs.length === node.pane.tabs.length) {
      return node;
    }
    // createPaneNode repoints focusedTabId to a surviving tab (or null) when the
    // previously focused tab was an ephemeral one that we just removed.
    return createPaneNode({
      id: node.pane.id,
      tabs: nextTabs,
      focusedTabId: node.pane.focusedTabId,
    });
  }
  return createGroupNode({
    id: node.group.id,
    direction: node.group.direction,
    children: node.group.children.map((child) => stripEphemeralTabsFromNode(child)),
    sizes: node.group.sizes,
  });
}

/**
 * Returns a copy of `layout` with every ephemeral tab (commit diff tabs) removed
 * from each pane. Applied in the layout store's `partialize` so commit diff tabs
 * are never written to storage — they're dropped on the next reload rather than
 * restored pointing at a possibly-rebased SHA. Working diff tabs and all other
 * tab kinds are left intact. Panes (and their ids/structure) are preserved even
 * when emptied; the parent-tab map is renormalized against the surviving tabs.
 */
export function stripEphemeralTabsFromLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const internalLayout = asInternalLayout(layout);
  const nextRoot = stripEphemeralTabsFromNode(internalLayout.root);
  return withNormalizedParentTabMap({
    root: nextRoot,
    focusedPaneId: internalLayout.focusedPaneId,
    parentTabIdByTabId: layout.parentTabIdByTabId,
  });
}

export function getFocusedBrowserId(layout: WorkspaceLayout | null | undefined): string | null {
  if (!layout) {
    return null;
  }
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  if (!focusedPane?.focusedTabId) {
    return null;
  }
  const focusedTab = collectAllTabs(layout.root).find(
    (tab) => tab.tabId === focusedPane.focusedTabId,
  );
  return focusedTab?.target.kind === "browser" ? focusedTab.target.browserId : null;
}

export function createDefaultLayout(): WorkspaceLayout {
  return {
    root: createPaneNode({ id: DEFAULT_PANE_ID }),
    focusedPaneId: DEFAULT_PANE_ID,
  };
}

/**
 * Adds an empty side pane when the layout has none, so the side panel can show
 * its launcher. Returns the existing pane otherwise.
 */
export function ensureSidePaneInLayout(
  input: EnsureSidePaneInLayoutInput,
): EnsureSidePaneInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const ensured = ensureSidePaneInternal(layout.root, input.createNodeId);
  if (ensured.root === layout.root) {
    return { layout: input.layout, paneId: ensured.paneId };
  }
  return {
    paneId: ensured.paneId,
    layout: withNormalizedParentTabMap({
      root: ensured.root,
      focusedPaneId: layout.focusedPaneId,
      parentTabIdByTabId: input.layout.parentTabIdByTabId,
    }),
  };
}

/**
 * Drops a side pane that holds no tabs, moving focus back to the main pane.
 * Returns null when there is nothing to remove.
 */
export function removeEmptySidePaneInLayout(layout: WorkspaceLayout): WorkspaceLayout | null {
  const internalLayout = asInternalLayout(layout);
  const sidePane = getSidePaneInternal(internalLayout.root);
  if (!sidePane || sidePane.tabs.length > 0) {
    return null;
  }
  const nextRoot = removePaneFromTree(internalLayout.root, sidePane.id) as SplitNodeInternal;
  return withNormalizedParentTabMap({
    root: nextRoot,
    focusedPaneId:
      internalLayout.focusedPaneId === sidePane.id
        ? getMainPaneInternal(nextRoot).id
        : internalLayout.focusedPaneId,
    parentTabIdByTabId: layout.parentTabIdByTabId,
  });
}

export function removePaneFromTree(root: SplitNode, paneId: string): SplitNode {
  const internalRoot = asInternalNode(root);
  const panePath = findPanePathById(internalRoot, paneId);
  if (!panePath) {
    return root;
  }
  return removePaneByPath(internalRoot, panePath);
}

export function removeTabFromTree(root: SplitNode, tabId: string): SplitNode {
  return detachTabFromTree(asInternalNode(root), { tabId }).root;
}

function resolveTargetPaneForNewTab(
  root: SplitNodeInternal,
  target: WorkspaceTabTarget,
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string,
): { root: SplitNodeInternal; pane: SplitPaneInternal } {
  if (!isSidePanelTabTarget(target)) {
    return { root, pane: getMainPaneInternal(root) };
  }
  const ensured = ensureSidePaneInternal(root, createNodeId);
  const pane = getSidePaneInternal(ensured.root);
  invariant(pane, "Side pane must exist after ensuring it");
  return { root: ensured.root, pane };
}

function insertNewTabIntoRoutedPane(input: {
  layout: WorkspaceLayout;
  target: WorkspaceTabTarget;
  now: number;
  focus: boolean;
  createNodeId?: (prefix: WorkspaceLayoutNodeIdPrefix) => string;
}): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const { root, pane } = resolveTargetPaneForNewTab(
    layout.root,
    input.target,
    input.createNodeId ?? defaultWorkspaceLayoutIds.createNodeId,
  );

  const tabId = buildDeterministicWorkspaceTabId(input.target);
  const nextTab: WorkspaceTab = {
    tabId,
    target: input.target,
    createdAt: input.now,
  };

  const preservedFocusTabId = pane.focusedTabId ?? tabId;

  return {
    tabId,
    layout: withNormalizedParentTabMap({
      root: insertTabIntoPane(root, {
        paneId: pane.id,
        tab: nextTab,
        focusTabId: input.focus ? tabId : preservedFocusTabId,
      }),
      focusedPaneId: input.focus ? pane.id : layout.focusedPaneId,
      parentTabIdByTabId: input.layout.parentTabIdByTabId,
    }),
  };
}

function findExistingTabForTarget(root: SplitNodeInternal, target: WorkspaceTabTarget) {
  const targetTabId = buildDeterministicWorkspaceTabId(target);
  return (
    collectAllTabs(root).find(
      (tab) => tab.tabId === targetTabId || workspaceTabTargetsEqual(tab.target, target),
    ) ?? null
  );
}

function updateExistingTabTarget(
  layout: WorkspaceLayout,
  tab: WorkspaceTab,
  target: WorkspaceTabTarget,
): WorkspaceLayout {
  if (workspaceTabTargetsEqual(tab.target, target)) {
    return layout;
  }
  return withNormalizedParentTabMap({
    ...layout,
    root: replaceTabInTree(asInternalNode(layout.root), {
      tabId: tab.tabId,
      nextTabId: tab.tabId,
      target,
    }),
  });
}

export function openTabInLayoutFocused(input: OpenTabInLayoutInput): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const existingTab = findExistingTabForTarget(layout.root, input.target);
  if (existingTab) {
    const nextLayout = updateExistingTabTarget(input.layout, existingTab, input.target);
    return {
      tabId: existingTab.tabId,
      layout:
        focusTabInLayout({
          layout: nextLayout,
          tabId: existingTab.tabId,
        }) ?? nextLayout,
    };
  }

  return insertNewTabIntoRoutedPane({ ...input, focus: true });
}

export function openTabInLayoutBackground(input: OpenTabInLayoutInput): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const existingTab = findExistingTabForTarget(layout.root, input.target);
  if (existingTab) {
    return {
      tabId: existingTab.tabId,
      layout: updateExistingTabTarget(input.layout, existingTab, input.target),
    };
  }

  return insertNewTabIntoRoutedPane({ ...input, focus: false });
}

export function closeTabInLayout(input: CloseTabInLayoutInput): WorkspaceLayout | null {
  const internalLayout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(internalLayout.root, input.tabId);
  if (!pane) {
    return null;
  }

  const closeSuccessorTabId = getCloseSuccessorTabId({
    pane,
    tabId: input.tabId,
    openTabIds: new Set(collectAllTabs(internalLayout.root).map((tab) => tab.tabId)),
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
  const fallbackPaneId = findNearestSiblingPaneId(internalLayout.root, pane.id);
  // Closing a tab never collapses the pane it was in. The main pane survives so
  // the side pane is never promoted into its place, and an emptied side pane
  // stays on its launcher rather than taking the panel out from under the click
  // that emptied it. Hiding the panel is what drops an empty side pane
  // (`removeEmptySidePaneInLayout`).
  const nextRoot = detachTabFromTree(internalLayout.root, {
    tabId: input.tabId,
    preserveEmptyPaneId: pane.id,
  }).root;
  const parentTabIdByTabId = normalizeParentTabMap({
    raw: input.layout.parentTabIdByTabId,
    openTabIds: new Set(collectAllTabs(nextRoot).map((tab) => tab.tabId)),
  });
  const nextFocusedPaneId = getFocusedPaneIdAfterTabClose({
    root: nextRoot,
    focusedPaneId: internalLayout.focusedPaneId,
    fallbackPaneId,
  });

  const nextLayout = {
    root: nextRoot,
    focusedPaneId: nextFocusedPaneId,
  };
  const nextLayoutWithParentMap = parentTabIdByTabId
    ? { ...nextLayout, parentTabIdByTabId }
    : nextLayout;

  if (closeSuccessorTabId && findPaneContainingTab(nextRoot, closeSuccessorTabId)) {
    const focusedLayout =
      focusTabInLayout({
        layout: nextLayoutWithParentMap,
        tabId: closeSuccessorTabId,
      }) ?? nextLayoutWithParentMap;
    return parentTabIdByTabId ? { ...focusedLayout, parentTabIdByTabId } : focusedLayout;
  }

  return nextLayoutWithParentMap;
}

export function focusTabInLayout(input: FocusTabInLayoutInput): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(layout.root, input.tabId);
  if (!pane) {
    return null;
  }

  if (pane.focusedTabId === input.tabId && layout.focusedPaneId === pane.id) {
    return null;
  }

  return withNormalizedParentTabMap({
    root: focusTabInPane(layout.root, pane.id, input.tabId),
    focusedPaneId: pane.id,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

export function retargetTabInLayout(
  input: RetargetTabInLayoutInput,
): RetargetTabInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(layout.root, input.tabId);
  if (!pane) {
    return null;
  }

  const currentTab = collectAllTabs(layout.root).find((tab) => tab.tabId === input.tabId) ?? null;
  if (currentTab && workspaceTabTargetsEqual(currentTab.target, input.target)) {
    return {
      layout: input.layout,
      tabId: input.tabId,
    };
  }

  const existingTargetTab =
    collectAllTabs(layout.root).find(
      (tab) => tab.tabId !== input.tabId && workspaceTabTargetsEqual(tab.target, input.target),
    ) ?? null;
  if (existingTargetTab) {
    const nextLayout =
      closeTabInLayout({
        layout: input.layout,
        tabId: input.tabId,
      }) ?? input.layout;
    return {
      layout:
        focusTabInLayout({
          layout: nextLayout,
          tabId: existingTargetTab.tabId,
        }) ?? nextLayout,
      tabId: existingTargetTab.tabId,
    };
  }

  const nextTabId =
    currentTab?.target.kind === "draft"
      ? input.tabId
      : buildDeterministicWorkspaceTabId(input.target);

  return {
    // Preserve draft-origin tab ids so draft->entity transitions keep the same
    // React key during the first render. Non-draft retargets must take the new
    // target identity immediately so local tab state cannot masquerade as the
    // previous agent/terminal/file.
    tabId: nextTabId,
    layout: withNormalizedParentTabMap({
      root: replaceTabInTree(layout.root, {
        tabId: input.tabId,
        nextTabId,
        target: input.target,
      }),
      focusedPaneId: layout.focusedPaneId,
      parentTabIdByTabId: input.layout.parentTabIdByTabId,
    }),
  };
}

export function convertDraftToAgentInLayout(
  input: ConvertDraftToAgentInLayoutInput,
): ConvertDraftToAgentInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  const currentTab = collectAllTabs(layout.root).find((tab) => tab.tabId === input.tabId) ?? null;
  if (!currentTab || currentTab.target.kind !== "draft") {
    return null;
  }

  const target: WorkspaceTabTarget = {
    kind: "agent",
    agentId: input.agentId,
  };
  const canonicalTabId = buildDeterministicWorkspaceTabId(target);
  const existingCanonicalTab =
    collectAllTabs(layout.root).find((tab) => tab.tabId === canonicalTabId) ?? null;

  if (existingCanonicalTab && existingCanonicalTab.tabId !== input.tabId) {
    const nextLayout =
      closeTabInLayout({
        layout: input.layout,
        tabId: input.tabId,
      }) ?? input.layout;
    return {
      layout:
        focusTabInLayout({
          layout: nextLayout,
          tabId: canonicalTabId,
        }) ?? nextLayout,
      tabId: canonicalTabId,
    };
  }

  return {
    tabId: canonicalTabId,
    layout: withNormalizedParentTabMap({
      root: replaceTabInTree(layout.root, {
        tabId: input.tabId,
        nextTabId: canonicalTabId,
        target,
      }),
      focusedPaneId: layout.focusedPaneId,
      parentTabIdByTabId: input.layout.parentTabIdByTabId,
    }),
  };
}

export function reorderFocusedPaneTabsInLayout(
  input: ReorderFocusedPaneTabsInLayoutInput,
): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  if (!layout.focusedPaneId || !findPaneById(layout.root, layout.focusedPaneId)) {
    return null;
  }

  return withNormalizedParentTabMap({
    root: updatePaneInTree(layout.root, {
      paneId: layout.focusedPaneId,
      updater: (pane) => reorderTabsForPane({ pane, tabIds: input.tabIds }),
    }),
    focusedPaneId: layout.focusedPaneId,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

export function moveTabToPaneInLayout(input: MoveTabToPaneInLayoutInput): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  const sourcePane = findPaneContainingTab(layout.root, input.tabId);
  if (!sourcePane || !findPaneById(layout.root, input.toPaneId)) {
    return null;
  }

  const mainPaneId = getMainPaneInternal(layout.root).id;
  const detached = detachTabFromTree(layout.root, {
    tabId: input.tabId,
    preserveEmptyPaneId:
      sourcePane.id === input.toPaneId || sourcePane.id === mainPaneId ? sourcePane.id : null,
  });
  if (!detached.tab) {
    return null;
  }

  return withNormalizedParentTabMap({
    root: insertTabIntoPane(detached.root, {
      paneId: input.toPaneId,
      tab: detached.tab,
      focusTabId: input.tabId,
    }),
    focusedPaneId: input.toPaneId,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

export function focusPaneInLayout(input: FocusPaneInLayoutInput): WorkspaceLayout | null {
  if (!findPaneById(input.layout.root, input.paneId)) {
    return null;
  }
  if (input.layout.focusedPaneId === input.paneId) {
    return null;
  }
  return withNormalizedParentTabMap({
    root: input.layout.root,
    focusedPaneId: input.paneId,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

export function resizeSplitInLayout(input: ResizeSplitInLayoutInput): WorkspaceLayout {
  const layout = asInternalLayout(input.layout);
  return withNormalizedParentTabMap({
    root: updateGroupSizesInTree(layout.root, {
      groupId: input.groupId,
      sizes: input.sizes,
    }),
    focusedPaneId: layout.focusedPaneId,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

export function reorderPaneTabsInLayout(
  input: ReorderPaneTabsInLayoutInput,
): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  if (!findPaneById(layout.root, input.paneId)) {
    return null;
  }

  return withNormalizedParentTabMap({
    root: updatePaneInTree(layout.root, {
      paneId: input.paneId,
      updater: (pane) => reorderTabsForPane({ pane, tabIds: input.tabIds }),
    }),
    focusedPaneId: layout.focusedPaneId,
    parentTabIdByTabId: input.layout.parentTabIdByTabId,
  });
}

function normalizeStringSet(values: Iterable<string>): Set<string> {
  const next = new Set<string>();
  for (const value of values) {
    const normalized = trimNonEmpty(value);
    if (normalized) {
      next.add(normalized);
    }
  }
  return next;
}

function normalizeParentTabMap(input: {
  raw: unknown;
  openTabIds: ReadonlySet<string>;
}): Record<string, string> | undefined {
  if (!input.raw || typeof input.raw !== "object" || Array.isArray(input.raw)) {
    return undefined;
  }

  const next: Record<string, string> = {};
  for (const [rawChildId, rawParentId] of Object.entries(input.raw)) {
    const childId = trimNonEmpty(rawChildId);
    const parentId = trimNonEmpty(typeof rawParentId === "string" ? rawParentId : null);
    if (
      !childId ||
      !parentId ||
      childId === parentId ||
      !input.openTabIds.has(childId) ||
      !input.openTabIds.has(parentId)
    ) {
      continue;
    }
    next[childId] = parentId;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeLayoutParentTabMap(layout: WorkspaceLayout): Record<string, string> | undefined {
  return normalizeParentTabMap({
    raw: layout.parentTabIdByTabId,
    openTabIds: new Set(collectAllTabs(layout.root).map((tab) => tab.tabId)),
  });
}

function withNormalizedParentTabMap(layout: WorkspaceLayout): WorkspaceLayout {
  const parentTabIdByTabId = normalizeLayoutParentTabMap(layout);
  return parentTabIdByTabId
    ? { ...layout, parentTabIdByTabId }
    : { root: layout.root, focusedPaneId: layout.focusedPaneId };
}

function getCloseSuccessorTabId(input: {
  pane: SplitPane;
  tabId: string;
  openTabIds: ReadonlySet<string>;
  parentTabIdByTabId?: Record<string, string>;
}): string | null {
  if (input.pane.focusedTabId !== input.tabId) {
    return null;
  }

  const tabIndex = input.pane.tabIds.indexOf(input.tabId);
  const parentTabId = input.parentTabIdByTabId?.[input.tabId] ?? null;
  if (parentTabId && input.openTabIds.has(parentTabId)) {
    return parentTabId;
  }

  return (
    input.pane.tabIds[tabIndex + 1] ??
    (tabIndex > 0 ? input.pane.tabIds[tabIndex - 1] : null) ??
    null
  );
}

function getFocusedPaneIdAfterTabClose(input: {
  root: SplitNode;
  focusedPaneId: string | null;
  fallbackPaneId: string | null;
}): string | null {
  if (input.focusedPaneId === null) {
    return null;
  }
  return (
    findPaneById(input.root, input.focusedPaneId)?.id ??
    (input.fallbackPaneId && findPaneById(input.root, input.fallbackPaneId)?.id) ??
    collectAllPanes(input.root)[0]?.id ??
    DEFAULT_PANE_ID
  );
}

function isEntityTarget(
  target: WorkspaceTabTarget,
): target is Extract<WorkspaceTabTarget, { kind: "agent" | "terminal" }> {
  return target.kind === "agent" || target.kind === "terminal";
}

function isAgentTab(
  tab: WorkspaceTab,
): tab is WorkspaceTab & { target: { kind: "agent"; agentId: string } } {
  return tab.target.kind === "agent";
}

function isTerminalTab(
  tab: WorkspaceTab,
): tab is WorkspaceTab & { target: { kind: "terminal"; terminalId: string } } {
  return tab.target.kind === "terminal";
}

function openEntityTabWithoutFocusing(
  layout: WorkspaceLayout,
  target: WorkspaceTabTarget,
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string,
): WorkspaceLayout {
  const internalLayout = asInternalLayout(layout);
  const { root, pane } = resolveTargetPaneForNewTab(internalLayout.root, target, createNodeId);

  const tabId = buildDeterministicWorkspaceTabId(target);
  return withNormalizedParentTabMap({
    root: insertTabIntoPane(root, {
      paneId: pane.id,
      tab: {
        tabId,
        target,
        createdAt: Date.now(),
      },
      focusTabId: pane.focusedTabId ?? tabId,
    }),
    focusedPaneId: internalLayout.focusedPaneId,
    parentTabIdByTabId: layout.parentTabIdByTabId,
  });
}

interface EntityTabGroup {
  target: WorkspaceTabTarget;
  tabs: WorkspaceTab[];
}

function applyPinnedAndHidden(input: {
  baseAgentIds: Set<string>;
  pinnedAgentIds: Set<string>;
  pendingAgentIds: Set<string>;
  hiddenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}): Set<string> {
  const { baseAgentIds, pinnedAgentIds, pendingAgentIds, hiddenAgentIds, knownAgentIds } = input;
  const result = new Set(baseAgentIds);
  for (const agentId of pinnedAgentIds) {
    if (knownAgentIds.has(agentId) || pendingAgentIds.has(agentId)) {
      result.add(agentId);
    }
  }
  for (const agentId of hiddenAgentIds) {
    result.delete(agentId);
  }
  return result;
}

function buildEntityTabGroups(initialTabs: WorkspaceTab[]): Map<string, EntityTabGroup> {
  const entityGroups = new Map<string, EntityTabGroup>();
  for (const tab of initialTabs) {
    if (!isEntityTarget(tab.target)) {
      continue;
    }
    const canonicalTarget = normalizeWorkspaceTabTarget(tab.target);
    if (!canonicalTarget) {
      continue;
    }
    const canonicalTabId = buildDeterministicWorkspaceTabId(canonicalTarget);
    const currentGroup = entityGroups.get(canonicalTabId);
    if (currentGroup) {
      currentGroup.tabs.push(tab);
      continue;
    }
    entityGroups.set(canonicalTabId, {
      target: canonicalTarget,
      tabs: [tab],
    });
  }
  return entityGroups;
}

function collapseStaleEntityTabs(input: {
  layout: WorkspaceLayout;
  snapshot: WorkspaceTabSnapshot;
  visibleAgentIds: Set<string>;
  knownTerminalIds: Set<string>;
}): WorkspaceLayout {
  const { snapshot, visibleAgentIds, knownTerminalIds } = input;
  let nextLayout = input.layout;
  for (const tab of collectAllTabs(nextLayout.root)) {
    if (isAgentTab(tab) && snapshot.agentsHydrated && !visibleAgentIds.has(tab.target.agentId)) {
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
    if (
      isTerminalTab(tab) &&
      snapshot.terminalsHydrated &&
      !knownTerminalIds.has(tab.target.terminalId)
    ) {
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
  }
  return nextLayout;
}

function addMissingEntityTabs(input: {
  layout: WorkspaceLayout;
  autoOpenAgentIds: Set<string>;
  representedAgentIds: Set<string>;
  standaloneTerminalIds: Set<string>;
  hasActivePendingDraftCreate: boolean;
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string;
}): WorkspaceLayout {
  const {
    autoOpenAgentIds,
    representedAgentIds,
    standaloneTerminalIds,
    hasActivePendingDraftCreate,
    createNodeId,
  } = input;
  let nextLayout = input.layout;
  const currentEntityTabs = collectAllTabs(nextLayout.root);
  const currentAgentIds = new Set(
    currentEntityTabs.filter(isAgentTab).map((tab) => tab.target.agentId),
  );
  const currentTerminalIds = new Set(
    currentEntityTabs.filter(isTerminalTab).map((tab) => tab.target.terminalId),
  );

  const sortedAutoOpenAgentIds = [...autoOpenAgentIds].sort();
  for (const agentId of sortedAutoOpenAgentIds) {
    if (currentAgentIds.has(agentId)) {
      continue;
    }
    if (hasActivePendingDraftCreate && !representedAgentIds.has(agentId)) {
      continue;
    }
    nextLayout = openEntityTabWithoutFocusing(
      nextLayout,
      {
        kind: "agent",
        agentId,
      },
      createNodeId,
    );
    currentAgentIds.add(agentId);
  }

  const sortedTerminalIds = [...standaloneTerminalIds].sort();
  for (const terminalId of sortedTerminalIds) {
    if (currentTerminalIds.has(terminalId)) {
      continue;
    }
    nextLayout = openEntityTabWithoutFocusing(
      nextLayout,
      {
        kind: "terminal",
        terminalId,
      },
      createNodeId,
    );
    currentTerminalIds.add(terminalId);
  }
  return nextLayout;
}

export function reconcileWorkspaceTabs(
  state: WorkspaceTabReconcileState,
  snapshot: WorkspaceTabSnapshot,
  createNodeId: (
    prefix: WorkspaceLayoutNodeIdPrefix,
  ) => string = defaultWorkspaceLayoutIds.createNodeId,
): WorkspaceTabReconcileState {
  let nextLayout = state.layout;
  const originalFocusedTabId =
    findPaneById(nextLayout.root, nextLayout.focusedPaneId)?.focusedTabId ?? null;
  let reconciledFocusedTabId = originalFocusedTabId;
  const pinnedAgentIds = new Set(state.pinnedAgentIds ?? []);
  const pendingAgentIds = new Set(state.pendingAgentIds ?? []);
  const hiddenAgentIds = new Set(state.hiddenAgentIds ?? []);
  const activeAgentIds = normalizeStringSet(snapshot.activeAgentIds);
  const autoOpenAgentIds = normalizeStringSet(snapshot.autoOpenAgentIds);
  const knownAgentIds = normalizeStringSet(snapshot.knownAgentIds);
  const standaloneTerminalIds = normalizeStringSet(snapshot.standaloneTerminalIds);
  const knownTerminalIds = snapshot.knownTerminalIds
    ? normalizeStringSet(snapshot.knownTerminalIds)
    : standaloneTerminalIds;
  const visibleAgentIds = applyPinnedAndHidden({
    baseAgentIds: activeAgentIds,
    pinnedAgentIds,
    pendingAgentIds,
    hiddenAgentIds,
    knownAgentIds,
  });
  const autoOpenSet = applyPinnedAndHidden({
    baseAgentIds: autoOpenAgentIds,
    pinnedAgentIds,
    pendingAgentIds,
    hiddenAgentIds,
    knownAgentIds,
  });

  const initialTabs = collectAllTabs(nextLayout.root);
  const representedAgentIds = new Set(
    initialTabs.filter(isAgentTab).map((tab) => tab.target.agentId),
  );

  const entityGroups = buildEntityTabGroups(initialTabs);

  for (const [canonicalTabId, group] of entityGroups) {
    const keeper = group.tabs.find((tab) => tab.tabId === canonicalTabId) ?? group.tabs[0] ?? null;
    if (!keeper) {
      continue;
    }
    if (group.tabs.some((tab) => tab.tabId === originalFocusedTabId)) {
      reconciledFocusedTabId = keeper.tabId;
    }
    if (!workspaceTabTargetsEqual(keeper.target, group.target)) {
      nextLayout = withNormalizedParentTabMap({
        root: replaceTabInTree(asInternalLayout(nextLayout).root, {
          tabId: keeper.tabId,
          nextTabId: keeper.tabId,
          target: group.target,
        }),
        focusedPaneId: nextLayout.focusedPaneId,
        parentTabIdByTabId: nextLayout.parentTabIdByTabId,
      });
    }
    for (const tab of group.tabs) {
      if (tab.tabId === keeper.tabId) {
        continue;
      }
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
  }

  nextLayout = collapseStaleEntityTabs({
    layout: nextLayout,
    snapshot,
    visibleAgentIds,
    knownTerminalIds,
  });

  nextLayout = addMissingEntityTabs({
    layout: nextLayout,
    autoOpenAgentIds: autoOpenSet,
    representedAgentIds,
    standaloneTerminalIds,
    hasActivePendingDraftCreate: snapshot.hasActivePendingDraftCreate ?? false,
    createNodeId,
  });

  if (reconciledFocusedTabId) {
    nextLayout =
      focusTabInLayout({
        layout: nextLayout,
        tabId: reconciledFocusedTabId,
      }) ?? nextLayout;
  }

  return {
    ...state,
    layout: nextLayout,
  };
}
