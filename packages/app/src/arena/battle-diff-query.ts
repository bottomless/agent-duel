import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { arenaSizeErrorOr, isArenaSizeError } from "./chat-too-large";

/**
 * A battle's changed files, without contents. The card, the archived summary and the side panel
 * share this key, so opening the panel on a battle the card already shows adds no request.
 */
export function useBattleDiff(
  serverId: string,
  agentId: string,
  turnId: string,
  options: { enabled?: boolean; retry?: boolean } = {},
) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const { enabled = true, retry = true } = options;
  return useFetchQuery<ArenaComparisonDiff>({
    queryKey: ["arena", "diff", serverId, agentId, turnId],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      try {
        return await client.arenaDiff(agentId, turnId);
      } catch (error) {
        throw arenaSizeErrorOr(error);
      }
    },
    enabled: Boolean(client) && enabled,
    // A comparison too large to send is refused the same way every time.
    retry: retry ? (failures, error) => failures < 2 && !isArenaSizeError(error) : false,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });
}

/**
 * Reads a battle's changes again when a side's result lands. Until then the engine reads a side
 * still running as the original, so the list and every file diff read while it ran are out of
 * date once it finishes. `results` names both sides' results; the keys stay the same, so the
 * old diff stays on screen while the new one loads.
 */
export function useRefetchBattleDiffOnResult(
  serverId: string,
  agentId: string,
  turnId: string,
  results: string,
) {
  const queryClient = useQueryClient();
  const previous = useRef(results);
  useEffect(() => {
    if (previous.current === results) return;
    previous.current = results;
    void queryClient.invalidateQueries({ queryKey: ["arena", "diff", serverId, agentId, turnId] });
    void queryClient.invalidateQueries({
      queryKey: ["arena", "file-diff", serverId, agentId, turnId],
    });
  }, [agentId, queryClient, results, serverId, turnId]);
}
