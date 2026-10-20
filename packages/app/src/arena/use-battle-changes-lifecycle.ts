import { useEffect } from "react";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  autoOpenBattleChanges,
  closeBattleChanges,
  isBattleChangesOpen,
  useBattleChangesStore,
} from "./battle-changes-store";

/**
 * When the Battle changes panel opens and closes without being asked. It opens once per battle,
 * when both results are in and the vote is waiting, because that is when the reader reads the
 * diffs. If the reader closes it while deciding, it stays closed for the chat. Closing again once
 * the battle is decided is the panel's own hook below. On a compact window the panel would
 * replace the chat, so it waits to be asked there.
 */
export function useBattleChangesLifecycle({
  serverId,
  workspaceId,
  agentId,
  turn,
  reviewAvailable,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  /** The battle on screen, if any. */
  turn: ArenaSnapshot["turn"];
  /** Both results are in and the card shows its review. */
  reviewAvailable: boolean;
}) {
  const compact = useIsCompactFormFactor();
  const turnId = turn?.id;
  const deciding = reviewAvailable && !turn?.resolution && turn?.state === "awaiting_vote";

  useEffect(() => {
    if (!turnId || !deciding || compact) return;
    const state = useBattleChangesStore.getState();
    if (state.dismissed[agentId] || state.autoOpenedTurn[agentId] === turnId) return;
    autoOpenBattleChanges({ serverId, workspaceId, agentId, turnId });
  }, [agentId, compact, deciding, serverId, turnId, workspaceId]);

  // The reader putting the panel away while deciding, by closing the tab or hiding the panel.
  useEffect(() => {
    if (!turnId || !deciding) return;
    const target = { serverId, workspaceId, agentId };
    let open = isBattleChangesOpen(target);
    return useWorkspaceLayoutStore.subscribe(() => {
      const next = isBattleChangesOpen(target);
      const wasOpen = open;
      open = next;
      if (!wasOpen || next) return;
      const state = useBattleChangesStore.getState();
      if (state.autoOpenedTurn[agentId] === turnId) state.dismiss(agentId);
    });
  }, [agentId, deciding, serverId, turnId, workspaceId]);
}

/**
 * The panel's half of the lifecycle: once the battle the decision opened it for is decided, it
 * closes, unless the reader opened it themselves since. It lives in the panel because the card leaves
 * the screen as the vote applies, before the battle reads as decided.
 */
export function useCloseBattleChangesWhenDecided({
  serverId,
  workspaceId,
  agentId,
  turn,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  turn: ArenaSnapshot["turn"];
}) {
  const turnId = turn?.id;
  const decided = turn?.state === "complete" || turn?.state === "discarded";
  useEffect(() => {
    if (!turnId || !decided) return;
    const state = useBattleChangesStore.getState();
    if (state.autoOpenedTurn[agentId] !== turnId) return;
    if ((state.turnByChat[agentId] ?? turnId) !== turnId) return;
    closeBattleChanges({ serverId, workspaceId, agentId });
  }, [agentId, decided, serverId, turnId, workspaceId]);
}
