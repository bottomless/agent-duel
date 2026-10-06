import { useCallback, useEffect, useMemo } from "react";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  resolveArenaExplorerTarget,
  selectArenaExplorerTargets,
  type ArenaExplorerTarget,
} from "./explorer-target";
import { resolveWorkspaceChatAgentId } from "./chat-agent";
import { useArenaExplorerSelectionStore } from "./explorer-selection";
import { useArenaSessionQuery } from "./use-arena-session";

export interface ArenaExplorerTargetState {
  /** Contestant worktrees the explorer can be pointed at right now. */
  targets: ArenaExplorerTarget[];
  selected: ArenaExplorerTarget | null;
  select: (side: ArenaSide | null) => void;
}

export function useArenaExplorerTarget(input: {
  serverId: string;
  workspaceId?: string | null;
}): ArenaExplorerTargetState {
  const { serverId, workspaceId } = input;
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  // The workspace's chat, not the focused tab: the Changes and Files panels take
  // focus as they open, and a focused-tab rule would drop the contestant entries
  // out of the very dropdown the person just opened.
  const agentId = useMemo(() => resolveWorkspaceChatAgentId(layout), [layout]);

  const { data: snapshot } = useArenaSessionQuery(serverId, agentId ?? "");
  const targets = useMemo(() => selectArenaExplorerTargets(snapshot), [snapshot]);

  // The selection is shared rather than the panel's own: a run's diff stats open
  // this tab already pointed at that run (`openArenaWorktreeChanges`).
  const selectedSide = useArenaExplorerSelectionStore((state) =>
    workspaceKey ? (state.sideByWorkspace[workspaceKey] ?? null) : null,
  );
  const selectSide = useArenaExplorerSelectionStore((state) => state.select);
  const selected = resolveArenaExplorerTarget(targets, selectedSide);
  useEffect(() => {
    // The battle ended, or moved on to a turn without this side: fall back to the
    // workspace checkout rather than browsing a directory that is being deleted.
    if (workspaceKey && selectedSide !== null && selected === null) {
      selectSide(workspaceKey, null);
    }
  }, [selectSide, selected, selectedSide, workspaceKey]);

  const select = useCallback(
    (side: ArenaSide | null) => {
      if (workspaceKey) {
        selectSide(workspaceKey, side);
      }
    },
    [selectSide, workspaceKey],
  );

  return { targets, selected, select };
}
