import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useFetchQuery } from "@/data/query";
import { StyleSheet } from "react-native-unistyles";
import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import { AgentStreamView } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { createPaneFocusContextValue, PaneFocusProvider } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { hydrateStreamState, type StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import { toErrorMessage } from "@/utils/error-messages";
import { TranscriptReader, transcriptFindHistory } from "./transcript-history";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
// The session store can still hold this chat's last live head, which the fetched pages also contain.
const EMPTY_STREAM_HEAD: StreamItem[] = [];
const IDLE_TURN = { isActive: false, isCancelling: false, startedAt: null, turnId: null };
type Cursor = FetchAgentTimelinePayload["startCursor"];

/** Reads history without unarchiving the workspace or enabling the composer. */
export function ArchivedTranscript({
  serverId,
  agentId,
  isWorkspaceFocused,
  onClose,
}: {
  serverId: string;
  agentId: string;
  isWorkspaceFocused: boolean;
  onClose: () => void;
}) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [pages, setPages] = useState<FetchAgentTimelinePayload[]>([]);
  const reader = useRef<TranscriptReader | null>(null);
  useEffect(() => {
    if (!client || !isWorkspaceFocused) return;
    const activeReader = new TranscriptReader(() => client.closeAgentHistory(agentId));
    reader.current = activeReader;
    return () => {
      reader.current = null;
      void activeReader.close().catch((error: unknown) => {
        console.error("Failed to close archived transcript reader", error);
      });
    };
  }, [client, agentId, isWorkspaceFocused]);
  const query = useFetchQuery({
    queryKey: ["archived-transcript", serverId, agentId, cursor],
    dataShape: "value",
    // Leaving closes the reader; re-entry needs the new reader's epoch even inside 30 seconds.
    staleTimeMs: 0,
    enabled: Boolean(client) && isWorkspaceFocused,
    queryFn: () => {
      if (!client) throw new Error("Connect to the host to read this transcript");
      if (!reader.current) throw new Error("Transcript is not active");
      return reader.current.read(() =>
        client.fetchAgentTimeline(agentId, {
          direction: cursor ? "before" : "tail",
          ...(cursor ? { cursor } : {}),
          projection: "projected",
          limit: 100,
        }),
      );
    },
    retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    const page = query.data;
    setPages((previous) => {
      const sameEpoch = previous.filter((item) => item.epoch === page.epoch);
      const retained = sameEpoch.filter((item) => item.startCursor?.seq !== page.startCursor?.seq);
      return [...retained, page].sort(
        (a, b) => (b.startCursor?.seq ?? 0) - (a.startCursor?.seq ?? 0),
      );
    });
  }, [query.data]);
  const oldest = pages.at(-1);
  const historyClient = useMemo<Pick<DaemonClient, "searchAgentTimeline"> | null>(() => {
    if (!client) return null;
    return {
      searchAgentTimeline(input) {
        if (!reader.current) return Promise.reject(new Error("Transcript is not active"));
        return reader.current.read(() => client.searchAgentTimeline(input));
      },
    };
  }, [client]);
  const findHistory = useMemo(
    () => transcriptFindHistory(pages, historyClient, agentId),
    [pages, historyClient, agentId],
  );
  const agent = pages?.[0]?.agent;
  const context = useMemo(
    () => ({
      serverId,
      id: agentId,
      cwd: agent?.cwd ?? "",
      provider: agent?.provider,
      status: "closed" as const,
    }),
    [agent, agentId, serverId],
  );
  const stream = useMemo(
    () =>
      hydrateStreamState(
        pages.toReversed().flatMap((page) =>
          page.entries.map((entry) => ({
            event: { type: "timeline" as const, provider: entry.provider, item: entry.item },
            timestamp: new Date(entry.timestamp),
            timelineCursor: { epoch: page.epoch, seq: entry.seqStart },
          })),
        ),
      ),
    [pages],
  );
  // The gate replaces the workspace panes, so the transcript is the one pane on this route.
  const paneFocus = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused, isPaneFocused: true }),
    [isWorkspaceFocused],
  );
  const { refetch } = query;
  const loadOlder = useCallback(() => {
    if (oldest?.startCursor) setCursor(oldest.startCursor);
  }, [oldest]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <View style={styles.container} testID="archived-transcript">
      <View style={styles.header}>
        <Text style={styles.title}>Archived chat · read only</Text>
        <Button size="md" variant="ghost" onPress={onClose}>
          Back
        </Button>
      </View>
      <Text style={styles.status}>
        Find searches loaded messages only. Load earlier messages to search more.
      </Text>
      {query.error ? (
        <View style={styles.header} accessibilityRole="alert">
          <Text style={styles.error}>{toErrorMessage(query.error)}</Text>
          <Button size="md" variant="outline" onPress={retry} loading={query.isFetching}>
            Retry transcript
          </Button>
        </View>
      ) : null}
      {query.isPending ? <Text style={styles.status}>Loading transcript…</Text> : null}
      {oldest?.hasOlder ? (
        <Button size="md" variant="ghost" onPress={loadOlder} loading={query.isFetching}>
          Load earlier messages
        </Button>
      ) : null}
      {pages.length > 0 && stream.length === 0 ? (
        <Text style={styles.status}>No saved messages in this archived chat.</Text>
      ) : null}
      {pages.length > 0 && stream.length > 0 ? (
        <PaneFocusProvider value={paneFocus}>
          <AgentStreamView
            agentId={agentId}
            serverId={serverId}
            context={context}
            streamItems={stream}
            streamHead={EMPTY_STREAM_HEAD}
            findHistory={findHistory}
            pendingPermissions={EMPTY_PERMISSIONS}
            turnPresentation={IDLE_TURN}
            isAuthoritativeHistoryReady
            readOnly
          />
        </PaneFocusProvider>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, width: "100%", minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.lg },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
