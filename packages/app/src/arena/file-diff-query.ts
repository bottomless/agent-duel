import type { ArenaComparisonFileDiff, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";

/**
 * One changed file's contents for the diff under its Changes row. The list names every file
 * without contents, so each diff reads its own file when it opens. A file read before shows at
 * once when its diff opens again, while the read repeats behind it.
 */
export function useArenaFileDiff(input: {
  serverId: string;
  agentId: string;
  turnId: string;
  /** Null reads nothing. */
  file: string | null;
  /**
   * The side still working while the other's result is shown. Its file is keyed apart, so an open
   * diff reads the file again once that side lands.
   */
  waitingFor?: ArenaSide;
}) {
  const { serverId, agentId, turnId, file, waitingFor } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return useFetchQuery<ArenaComparisonFileDiff>({
    queryKey: [
      "arena",
      "file-diff",
      serverId,
      agentId,
      turnId,
      file,
      ...(waitingFor ? [`waiting:${waitingFor}`] : []),
    ],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      if (file === null) throw new Error("No file to read");
      return client.arenaFileDiff(agentId, turnId, file);
    },
    enabled: Boolean(client) && file !== null,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });
}
