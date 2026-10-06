import { create } from "zustand";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceSidePanelTab } from "@/workspace/side-panel-command";

interface ArenaExplorerSelectionStore {
  /** The contestant the Changes and Files tabs browse, per workspace. */
  sideByWorkspace: Record<string, ArenaSide | null>;
  select(workspaceKey: string, side: ArenaSide | null): void;
}

/**
 * Which contestant worktree the side panel is pointed at.
 *
 * The panels own the picker, but they are not the only ones who aim it: a run's
 * diff stats open the Changes tab already looking at that run. The choice
 * therefore outlives the panel that displays it and lives here rather than in
 * the panel's own state. It is deliberately not persisted -- a battle's
 * worktrees are gone by the next launch.
 */
export const useArenaExplorerSelectionStore = create<ArenaExplorerSelectionStore>((set) => ({
  sideByWorkspace: {},
  select: (workspaceKey, side) =>
    set((state) =>
      state.sideByWorkspace[workspaceKey] === side
        ? state
        : { sideByWorkspace: { ...state.sideByWorkspace, [workspaceKey]: side } },
    ),
}));

/** Opens the Changes tab on one contestant's worktree, revealing the panel. */
export function openArenaWorktreeChanges(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  side: ArenaSide;
}): void {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    return;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId });
  if (!workspaceKey) {
    return;
  }
  // Aim the picker before the tab opens: the panel reads the selection on its
  // first render, so a retarget afterwards would show the checkout for a frame.
  useArenaExplorerSelectionStore.getState().select(workspaceKey, input.side);
  openWorkspaceSidePanelTab({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "changes" },
  });
}
