import { useMemo, useState } from "react";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { pendingArenaPrompt, projectPendingArenaPrompt } from "./summary-anchor";

interface PendingArenaPromptOptions {
  serverId: string;
  agentId: string;
  snapshot: ArenaSnapshot | undefined;
  streamItems: StreamItem[];
  streamHead: StreamItem[];
  hasAppliedAuthoritativeHistory: boolean;
}

export function usePendingArenaPrompt({
  serverId,
  agentId,
  snapshot,
  streamItems,
  streamHead,
  hasAppliedAuthoritativeHistory,
}: PendingArenaPromptOptions) {
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
  const timelineRange = useSessionStore((state) =>
    state.sessions[serverId]?.agentTimelineCursor.get(agentId),
  );
  const hasOlderTimeline = useSessionStore(
    (state) => state.sessions[serverId]?.agentTimelineHasOlder.get(agentId) === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const panelActive = useRetainedPanelActive();
  const turn = snapshot?.turn;
  const needsPromptPosition =
    panelActive &&
    hasAppliedAuthoritativeHistory &&
    hasOlderTimeline &&
    timelineRange !== undefined &&
    turn?.state === "complete" &&
    turn.id === pendingTurnId;
  const promptIndex = useFetchQuery({
    queryKey: ["arena", "prompt-handoff", serverId, agentId, pendingTurnId, timelineRange?.epoch],
    dataShape: "value",
    staleTimeMs: 0,
    enabled: needsPromptPosition && Boolean(client && agentId),
    queryFn: async () => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      return client.listAgentTimelinePrompts(agentId);
    },
    // The durable index may lag the live timeline broadcast. Stop when the handoff clears.
    refetchInterval: needsPromptPosition ? 1000 : false,
  });
  const pendingPrompt = pendingArenaPrompt({
    snapshot,
    streamItems: [...streamItems, ...streamHead],
    pendingTurnId,
    timelineRange,
    promptIndex: promptIndex.data,
  });
  const nextPendingTurnId = pendingPrompt?.id ?? null;
  // Render-time tracking avoids a blank frame at completion. Reloaded history does not
  // start a handoff, and pagination cannot restart a finished one.
  if (nextPendingTurnId !== pendingTurnId) {
    setPendingTurnId(nextPendingTurnId);
  }
  return useMemo(
    () => projectPendingArenaPrompt(streamItems, pendingPrompt),
    [streamItems, pendingPrompt],
  );
}
