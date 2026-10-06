import { useRetainedPanelActive } from "@/components/retained-panel";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useReplicaQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { arenaSubscription } from "./stream-subscription";

const listenNothing = () => () => {};
const noError = () => null;
export function useArenaStream(serverId: string, agentId: string, turnId?: string) {
  const queryClient = useQueryClient();
  const active = useRetainedPanelActive();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.arena === true,
  );
  const subscription = useMemo(
    () =>
      active && client && supported && agentId
        ? arenaSubscription(
            queryClient,
            client,
            agentId,
            turnId ? { kind: "turn", turnId } : { kind: "current" },
            turnId
              ? ["arena", "turn", serverId, agentId, turnId]
              : ["arena", "session", serverId, agentId],
          )
        : null,
    [queryClient, client, supported, serverId, agentId, turnId, active],
  );
  useEffect(() => subscription?.retain(), [subscription]);
  const error = useSyncExternalStore(
    subscription?.listen ?? listenNothing,
    subscription?.getError ?? noError,
    noError,
  );
  const query = useReplicaQuery<ArenaSnapshot>({
    queryKey: turnId
      ? ["arena", "turn", serverId, agentId, turnId]
      : ["arena", "session", serverId, agentId],
    pushEvent: "arena.stream.update",
    enabled: false,
    structuralSharing: false,
  });
  return {
    ...query,
    client,
    supported,
    subscription,
    error,
    isError: Boolean(error),
    isLoading: Boolean(subscription) && !query.data && !error,
    refetch: subscription?.refresh ?? (() => Promise.resolve({ isError: true, data: query.data })),
  };
}
