import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { create } from "zustand";
import { arenaSubscription, type ArenaStreamClient } from "@/arena/stream-subscription";
import { hasDraftBattle } from "@/composer/draft/failed-first-send";

/**
 * A first battle whose start response was lost (timeout or disconnect) while the engine may
 * still admit it. The draft keeps its composer and error; this record lets the draft tab watch
 * the created agent's arena stream and hand the battle off the moment the engine admits it,
 * without a second send. Cleared when a new submission starts or the battle is confirmed.
 */
export interface LateFirstBattle {
  serverId: string;
  agentId: string;
  prompt: string;
  result: AgentSnapshotPayload;
}

interface LateFirstBattleState {
  byDraftId: Readonly<Record<string, LateFirstBattle>>;
  set: (draftId: string, battle: LateFirstBattle) => void;
  clear: (draftId: string) => void;
}

export const useLateFirstBattleStore = create<LateFirstBattleState>((set) => ({
  byDraftId: {},
  set: (draftId, battle) =>
    set((state) => ({ byDraftId: { ...state.byDraftId, [draftId]: battle } })),
  clear: (draftId) =>
    set((state) => {
      if (!state.byDraftId[draftId]) return state;
      const { [draftId]: _removed, ...rest } = state.byDraftId;
      return { byDraftId: rest };
    }),
}));

/**
 * Watch the created agent's arena stream until the lost start's turn appears, then hand off
 * once. Shares the agent panel's subscription and query key, so the handoff seeds the same
 * snapshot the panel paints from and the stream carries on without a gap. The subscription's
 * own reconnect backoff covers a daemon that is still down; releasing it is the caller's stop.
 */
export function watchLateFirstBattleAdmission(input: {
  queryClient: QueryClient;
  client: ArenaStreamClient;
  agentId: string;
  queryKey: QueryKey;
  prompt: string;
  onAdmitted: (snapshot: ArenaSnapshot) => void;
}): () => void {
  const subscription = arenaSubscription(
    input.queryClient,
    input.client,
    input.agentId,
    { kind: "current" },
    input.queryKey,
  );
  const release = subscription.retain();
  let admitted = false;
  const check = (snapshot: ArenaSnapshot | undefined) => {
    if (admitted || !snapshot || !hasDraftBattle(snapshot, input.prompt)) return;
    admitted = true;
    input.onAdmitted(snapshot);
  };
  const key = hashKey(input.queryKey);
  const unsubscribe = input.queryClient.getQueryCache().subscribe((event) => {
    if (hashKey(event.query.queryKey) !== key) return;
    check(input.queryClient.getQueryData<ArenaSnapshot>(event.query.queryKey));
  });
  // A remount can find the battle already admitted and in the cache.
  check(input.queryClient.getQueryData<ArenaSnapshot>(input.queryKey));
  return () => {
    unsubscribe();
    release();
  };
}
