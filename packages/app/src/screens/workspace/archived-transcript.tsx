import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useFetchQuery } from "@/data/query";
import { StyleSheet } from "react-native-unistyles";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import { AgentStreamView } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { hydrateStreamState } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import { toErrorMessage } from "@/utils/error-messages";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const IDLE_TURN = { isActive: false, isCancelling: false, startedAt: null, turnId: null };
type Cursor = FetchAgentTimelinePayload["startCursor"];

/** Reads history without unarchiving the workspace or enabling the composer. */
export function ArchivedTranscript({
  serverId,
  agentId,
  onClose,
}: {
  serverId: string;
  agentId: string;
  onClose: () => void;
}) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [pages, setPages] = useState<FetchAgentTimelinePayload[]>([]);
  const query = useFetchQuery({
    queryKey: ["archived-transcript", serverId, agentId, cursor],
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: () => {
      if (!client) throw new Error("Connect to the host to read this transcript");
      return client.fetchAgentTimeline(agentId, {
        direction: cursor ? "before" : "tail",
        ...(cursor ? { cursor } : {}),
        projection: "projected",
        limit: 100,
      });
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
        <Button size="sm" variant="ghost" onPress={onClose}>
          Back
        </Button>
      </View>
      {query.error ? (
        <View style={styles.header} accessibilityRole="alert">
          <Text style={styles.error}>{toErrorMessage(query.error)}</Text>
          <Button size="sm" variant="outline" onPress={retry} loading={query.isFetching}>
            Retry transcript
          </Button>
        </View>
      ) : null}
      {query.isPending ? <Text style={styles.status}>Loading transcript…</Text> : null}
      {oldest?.hasOlder ? (
        <Button size="sm" variant="ghost" onPress={loadOlder} loading={query.isFetching}>
          Load earlier messages
        </Button>
      ) : null}
      {pages.length > 0 && stream.length === 0 ? (
        <Text style={styles.status}>No saved messages in this archived chat.</Text>
      ) : null}
      {pages.length > 0 && stream.length > 0 ? (
        <AgentStreamView
          agentId={agentId}
          serverId={serverId}
          context={context}
          streamItems={stream}
          pendingPermissions={EMPTY_PERMISSIONS}
          turnPresentation={IDLE_TURN}
          isAuthoritativeHistoryReady
          readOnly
        />
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
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
