import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  arenaOnScreenTurnId,
  pendingArenaPrompt,
  projectDiscardedArenaPrompts,
  projectPendingArenaPrompt,
} from "./summary-anchor";
import { replaceShellRestartErrors } from "./shell-restart";

const EMPTY_HISTORY: ArenaSnapshot["history"] = [];

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
  const { t } = useTranslation();
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
      if (!client) throw new Error(t("arena.connectionUnavailable"));
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
  const history = snapshot?.history ?? EMPTY_HISTORY;
  // The battle on screen shows its own prompt while its discard lands.
  const onScreenTurnId = arenaOnScreenTurnId(snapshot);
  // Render-time tracking avoids a blank frame at completion. Reloaded history does not
  // start a handoff, and pagination cannot restart a finished one.
  if (nextPendingTurnId !== pendingTurnId) {
    setPendingTurnId(nextPendingTurnId);
  }
  return useMemo(() => {
    const notice = t("arena.engineRestartedCommandStopped");
    const stops = snapshot?.chat.shellStops;
    const tail = replaceShellRestartErrors(streamItems, stops, notice);
    const head = replaceShellRestartErrors(streamHead, stops, notice);
    const withDiscarded = projectDiscardedArenaPrompts({ tail, head }, history, {
      onScreenTurnId,
      hasOlderTimeline,
    });
    return projectPendingArenaPrompt(withDiscarded, pendingPrompt);
  }, [
    streamItems,
    streamHead,
    pendingPrompt,
    snapshot?.chat.shellStops,
    t,
    history,
    onScreenTurnId,
    hasOlderTimeline,
  ]);
}
