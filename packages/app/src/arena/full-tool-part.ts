import { createContext, useContext } from "react";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { arenaSizeErrorOr, isArenaSizeError } from "./chat-too-large";

type UnknownRecord = Record<string, unknown>;

/** The daemon and chat a battle's panes come from, so a pane can ask for one of its parts whole. */
export const ArenaPartSourceContext = createContext<{ serverId: string; agentId: string } | null>(
  null,
);

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

/** A snapshot sends a tool call's large fields shortened and lists them (engine `withPartPreviews`). */
export function arenaToolPartPreviewed(part: UnknownRecord): boolean {
  const previewed = record(part.state)?.previewed;
  return Array.isArray(previewed) && previewed.length > 0;
}

/**
 * The part whole once its finished call is opened, when its snapshot copy was shortened. A running
 * call keeps its preview, whose end is the latest output, and so does a call whose fetch fails.
 */
export function useFullToolPart(part: UnknownRecord, runId: string | undefined, opened: boolean) {
  const source = useContext(ArenaPartSourceContext);
  const client = useSessionStore((state) =>
    source ? (state.sessions[source.serverId]?.client ?? null) : null,
  );
  const partId = typeof part.id === "string" ? part.id : undefined;
  const status = record(part.state)?.status;
  const query = useFetchQuery({
    queryKey: ["arena", "run-part", source?.serverId, source?.agentId, runId, partId],
    dataShape: "value",
    // A finished call's part does not change; this only bounds how long it is kept.
    staleTimeMs: 5 * 60_000,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      if (!client || !source || !runId || !partId) return null;
      try {
        return record(
          await client.arenaRunPart(source.agentId, runId, partId, {
            ...(typeof part.sessionID === "string" ? { sessionId: part.sessionID } : {}),
            ...(typeof part.messageID === "string" ? { messageId: part.messageID } : {}),
          }),
        );
      } catch (error) {
        throw arenaSizeErrorOr(error);
      }
    },
    // A part too large to send is refused the same way every time.
    retry: (failures, error) => failures < 2 && !isArenaSizeError(error),
    enabled:
      opened &&
      status !== "running" &&
      status !== "pending" &&
      arenaToolPartPreviewed(part) &&
      Boolean(client && source && runId && partId),
  });
  return query.data ?? part;
}
