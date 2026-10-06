import { useEffect, useRef, useState } from "react";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

export function useVisibleSingleAgentIdentity(
  status: AgentLifecycleStatus | undefined,
  singleAgent: ArenaSnapshot["singleAgent"],
  refetch: () => Promise<{ isError: boolean; data?: ArenaSnapshot }>,
) {
  const passIsRunning = status === "initializing" || status === "running";
  const [snapshotPending, setSnapshotPending] = useState(false);
  const previousRatingId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (passIsRunning) {
      if (singleAgent) previousRatingId.current = singleAgent.id;
      setSnapshotPending(true);
      return;
    }
    if (!snapshotPending) return;
    if (singleAgent && singleAgent.id !== previousRatingId.current) {
      setSnapshotPending(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (cancelled) return;
        const result = await refetch();
        if (result.isError) return;
        if (result.data?.singleAgent && result.data.singleAgent.id !== previousRatingId.current) {
          if (!cancelled) setSnapshotPending(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [passIsRunning, refetch, singleAgent, snapshotPending]);

  return passIsRunning || snapshotPending ? undefined : singleAgent;
}
