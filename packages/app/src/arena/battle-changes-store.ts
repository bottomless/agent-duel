import { create } from "zustand";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { getWorkspaceSidePane } from "@/stores/workspace-layout-actions";
import {
  selectIsWorkspaceSidePanelOpen,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openWorkspaceSidePanelTab } from "@/workspace/side-panel-command";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";

/** Per chat: a workspace has one chat, and its panel shows one battle at a time. */
interface BattleChangesStore {
  /** The battle the panel shows. Absent means the chat's current battle. */
  turnByChat: Record<string, string>;
  /**
   * The battle whose decision opened the panel, so it opens once per battle and closes again
   * once that battle is decided. Opening it yourself clears it, and the panel then stays.
   */
  autoOpenedTurn: Record<string, string>;
  /**
   * Chats whose reader closed the panel a decision had opened. It stays closed for the rest of
   * the session there: a panel that keeps coming back after being put away is one the reader
   * fights rather than reads.
   */
  dismissed: Record<string, true>;
  /** Whose changes the panel shows. Absent means Agent A. */
  sideByChat: Record<string, ArenaSide>;
  /** The panel's view options, the same in every chat: long lines wrap, the file list shows. */
  wrapLines: boolean;
  showFileList: boolean;
  setWrapLines: (wrap: boolean) => void;
  setShowFileList: (show: boolean) => void;
  show: (agentId: string, turnId: string) => void;
  setSide: (agentId: string, side: ArenaSide) => void;
  markAutoOpened: (agentId: string, turnId: string) => void;
  claim: (agentId: string) => void;
  dismiss: (agentId: string) => void;
}

export const useBattleChangesStore = create<BattleChangesStore>((set) => ({
  turnByChat: {},
  autoOpenedTurn: {},
  dismissed: {},
  sideByChat: {},
  // Wrapping is on by default: a docked panel is narrow, and a cut line hides what changed.
  wrapLines: true,
  showFileList: false,
  setWrapLines: (wrapLines) => set({ wrapLines }),
  setShowFileList: (showFileList) => set({ showFileList }),
  show: (agentId, turnId) =>
    set((state) => ({ turnByChat: { ...state.turnByChat, [agentId]: turnId } })),
  setSide: (agentId, side) =>
    set((state) => ({ sideByChat: { ...state.sideByChat, [agentId]: side } })),
  markAutoOpened: (agentId, turnId) =>
    set((state) => ({ autoOpenedTurn: { ...state.autoOpenedTurn, [agentId]: turnId } })),
  claim: (agentId) =>
    set((state) => {
      if (!(agentId in state.autoOpenedTurn)) return state;
      const { [agentId]: _claimed, ...autoOpenedTurn } = state.autoOpenedTurn;
      return { autoOpenedTurn };
    }),
  dismiss: (agentId) => set((state) => ({ dismissed: { ...state.dismissed, [agentId]: true } })),
}));

export function battleChangesTarget(agentId: string): WorkspaceTabTarget {
  return { kind: "arena_changes", agentId };
}

function workspaceKeyFor(serverId: string, workspaceId: string | null | undefined): string | null {
  const id = workspaceId?.trim();
  return id ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: id }) : null;
}

/**
 * Whether the chat's Battle changes tab is in a side panel that is showing. Another tab in front
 * of it still counts: the reader switched tabs, they did not put the changes away.
 */
export function isBattleChangesOpen(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): boolean {
  const key = workspaceKeyFor(input.serverId, input.workspaceId);
  if (!key) return false;
  const layoutState = useWorkspaceLayoutStore.getState();
  if (!selectIsWorkspaceSidePanelOpen(layoutState, key)) return false;
  const layout = layoutState.layoutByWorkspace[key];
  const sidePane = layout ? getWorkspaceSidePane(layout.root) : null;
  const tabId = buildDeterministicWorkspaceTabId(battleChangesTarget(input.agentId));
  return sidePane?.tabIds.includes(tabId) === true;
}

/** Shows a battle's changes in the side panel. The reader asked for it, so focus moves there. */
export function openBattleChanges(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
  turnId: string;
  /** Opens on this agent's changes rather than the one the reader last picked. */
  side?: ArenaSide;
}): void {
  const store = useBattleChangesStore.getState();
  store.show(input.agentId, input.turnId);
  if (input.side) store.setSide(input.agentId, input.side);
  store.claim(input.agentId);
  openWorkspaceSidePanelTab({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: battleChangesTarget(input.agentId),
  });
}

/**
 * Opens the panel on its own at the decision. The chat keeps keyboard focus, since the reader
 * is about to vote or type there, and a panel the reader has hidden stays hidden.
 */
export function autoOpenBattleChanges(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
  turnId: string;
}): boolean {
  const key = workspaceKeyFor(input.serverId, input.workspaceId);
  if (!key) return false;
  const layoutStore = useWorkspaceLayoutStore.getState();
  if (layoutStore.sidePanelOpenByWorkspace[key] === false) return false;
  const focusedPaneId = layoutStore.layoutByWorkspace[key]?.focusedPaneId ?? null;
  useBattleChangesStore.getState().show(input.agentId, input.turnId);
  layoutStore.openTabFocused(key, battleChangesTarget(input.agentId));
  if (focusedPaneId) useWorkspaceLayoutStore.getState().focusPane(key, focusedPaneId);
  useBattleChangesStore.getState().markAutoOpened(input.agentId, input.turnId);
  return true;
}

/** Closes the chat's Battle changes tab, if it is open. */
export function closeBattleChanges(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): void {
  const key = workspaceKeyFor(input.serverId, input.workspaceId);
  if (!key) return;
  const tabId = buildDeterministicWorkspaceTabId(battleChangesTarget(input.agentId));
  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[key];
  const sidePane = layout ? getWorkspaceSidePane(layout.root) : null;
  if (!sidePane?.tabIds.includes(tabId)) return;
  layoutStore.closeTab(key, tabId);
  // The panel was opened for this; with nothing else in it, closing the tab puts it away too.
  const after = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  const remaining = after ? getWorkspaceSidePane(after.root) : null;
  if (remaining && remaining.tabIds.length === 0) layoutStore.setSidePanelOpen(key, false);
}
