import { useEffect, useState } from "react";
import { initialLoopbackHistoryState, stepLoopbackHistory } from "./loopback-history";
import { ArenaLoopbackRequiredError } from "./loopback-required";
import { useArenaStream } from "./use-arena-stream";

/**
 * Whether the chat hides its history banner because the battle stream already shows the loopback
 * refusal. Fetches history again once the stream answers with a snapshot.
 */
export function useArenaLoopbackHidesHistoryError(input: {
  serverId: string;
  agentId: string | undefined;
  historyFailed: boolean;
  retryHistory: () => void;
}): boolean {
  const { serverId, agentId, historyFailed, retryHistory } = input;
  const stream = useArenaStream(serverId, agentId ?? "");
  const [state, setState] = useState(initialLoopbackHistoryState);
  const refused = stream.error instanceof ArenaLoopbackRequiredError;
  const step = stepLoopbackHistory(state, {
    refused,
    streamFailed: stream.error !== null && !refused,
    dataUpdatedAt: stream.dataUpdatedAt,
    historyFailed,
  });
  const nextRefusedAt = step.state.refusedAt;
  useEffect(() => {
    if (nextRefusedAt !== state.refusedAt) setState({ refusedAt: nextRefusedAt });
    if (step.retryHistory) retryHistory();
  }, [nextRefusedAt, state.refusedAt, step.retryHistory, retryHistory]);
  return step.hideHistoryError;
}
