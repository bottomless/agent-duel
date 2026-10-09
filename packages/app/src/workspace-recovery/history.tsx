import { useCallback, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useFetchQueries } from "@/data/query";
import { queryClient } from "@/data/query-client";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { toErrorMessage } from "@/utils/error-messages";

type Recovery = Awaited<ReturnType<DaemonClient["listWorkspaceRecoveries"]>>[number];
type RecoveryRow = Recovery & { serverId: string; hostName: string };

export function useWorkspaceRecoveryHistory(serverId: string | null, search: string) {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  useSyncExternalStore(
    (notify) => runtime.subscribeAll(notify),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const targets = hosts.filter((host) => !serverId || host.serverId === serverId);
  const queries = useFetchQueries<Recovery[]>(
    targets.map((host) => {
      const snapshot = runtime.getSnapshot(host.serverId);
      const client = runtime.getClient(host.serverId);
      return {
        queryKey: ["workspaceRecoveryHistory", host.serverId, snapshot?.connectionEpoch],
        enabled: Boolean(client && isHostRuntimeConnected(snapshot)),
        dataShape: "list",
        staleTimeMs: 0,
        retry: false,
        queryFn: async () => {
          if (!client) throw new Error("Host unavailable");
          return client.listWorkspaceRecoveries();
        },
      };
    }),
  );
  const entries: RecoveryRow[] = [];
  const failedHosts: string[] = [];
  const searchText = search.trim().toLocaleLowerCase();
  queries.forEach((result, index) => {
    const host = targets[index]!;
    if (!isHostRuntimeConnected(runtime.getSnapshot(host.serverId)) || result.isError) {
      failedHosts.push(host.label);
      return;
    }
    for (const entry of result.data ?? []) {
      if (!searchText || `${entry.name} ${entry.cwd}`.toLocaleLowerCase().includes(searchText)) {
        entries.push({ ...entry, serverId: host.serverId, hostName: host.label });
      }
    }
  });
  entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return {
    entries,
    failedHosts,
    isLoading: queries.some((query) => query.isLoading),
    refresh: () =>
      Promise.all(queries.filter((query) => query.isEnabled).map((query) => query.refetch())),
  };
}

/** Interrupted forks, at the top of the sidebar's Archived view: they are archived workspaces too. */
export function WorkspaceRecoveryHistory({
  entries,
  failedHosts,
  onRefresh,
}: {
  entries: RecoveryRow[];
  failedHosts: string[];
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (entries.length === 0 && failedHosts.length === 0) return null;
  return (
    <View style={styles.section} testID="workspace-recovery-history">
      <Text style={styles.heading}>{t("sidebar.archived.interruptedForks")}</Text>
      {failedHosts.map((host) => (
        <Text key={host} style={styles.hostError}>
          {t("sidebar.archived.recoveryLoadFailed", { host })}
        </Text>
      ))}
      {failedHosts.length > 0 ? (
        <View style={styles.retry}>
          <Button variant="ghost" size="xs" onPress={onRefresh}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {entries.map((entry) => (
        <RecoveryHistoryRow key={`${entry.serverId}:${entry.workspaceId}`} entry={entry} />
      ))}
    </View>
  );
}

function RecoveryHistoryRow({ entry }: { entry: RecoveryRow }) {
  const { t } = useTranslation();
  const restore = useMutation({
    mutationFn: async () => {
      const runtime = getHostRuntimeStore();
      const client = runtime.getClient(entry.serverId);
      if (!client || !isHostRuntimeConnected(runtime.getSnapshot(entry.serverId))) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      await client.restoreWorkspace(entry.workspaceId);
      await queryClient.invalidateQueries({
        queryKey: ["workspaceRecoveryHistory", entry.serverId],
      });
      navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId });
    },
  });
  const handleRestore = useCallback(() => restore.mutate(), [restore]);
  return (
    <View style={styles.row} testID={`workspace-recovery-${entry.workspaceId}`}>
      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
        <Text style={styles.secondary} numberOfLines={1}>
          {t("sidebar.archived.forkFilesPreserved")}
        </Text>
        {restore.isError ? <Text style={styles.error}>{toErrorMessage(restore.error)}</Text> : null}
      </View>
      <Button variant="outline" size="xs" disabled={restore.isPending} onPress={handleRestore}>
        {restore.isPending ? t("common.loading") : t("sidebar.archived.restore")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { paddingBottom: theme.spacing[2] },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  retry: { alignItems: "flex-start" },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
  },
  details: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, opacity: 0.76 },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  hostError: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[2],
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
