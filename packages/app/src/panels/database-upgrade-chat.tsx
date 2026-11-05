import { type ReactNode, useEffect } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { databaseUpgradeNotice } from "@/utils/database-upgrade-notice";
import {
  DATABASE_UPGRADE_CHAT_MESSAGE,
  databaseImportChatMessage,
  isImportMissingSession,
  watchDatabaseImportError,
} from "./database-import-error";

export function DatabaseUpgradeChat({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}) {
  const waiting = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (
      !session ||
      !agentId ||
      !databaseUpgradeNotice([session]) ||
      session.serverInfo?.arenaDatabaseUpgrade?.backgroundImport
    )
      return false;
    const status = selectAgentTimelineState(session, agentId).status;
    return status !== "synced" && status !== "painted";
  });

  // Keep lookups unmounted until ready, so a transient missing session cannot become a load error.
  // Like the sidebar upgrade notice, this maintenance text is currently English in every locale.
  if (waiting) {
    return <DatabaseUpgradeMessage />;
  }
  return children;
}

export function DatabaseImportError({
  serverId,
  message,
  onRetry,
  retryWhileImporting = false,
  children,
}: {
  serverId: string;
  message: string;
  onRetry: () => void;
  retryWhileImporting?: boolean;
  children: ReactNode;
}) {
  const importing = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.arenaDatabaseUpgrade?.backgroundImport === true,
  );
  const missingSession = isImportMissingSession(message);
  useEffect(() => {
    if (!missingSession) return;
    return watchDatabaseImportError({
      initiallyImporting: importing,
      getImportRunning: () =>
        useSessionStore.getState().sessions[serverId]?.serverInfo?.arenaDatabaseUpgrade
          ?.backgroundImport === true,
      subscribe: (listener) => useSessionStore.subscribe(listener),
      retry: onRetry,
      retryWhileImporting,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    });
  }, [serverId, missingSession, importing, onRetry, retryWhileImporting]);
  return databaseImportChatMessage(importing, message) ? <DatabaseUpgradeMessage /> : children;
}

function DatabaseUpgradeMessage() {
  return (
    <View style={styles.container} testID="database-upgrade-chat">
      <Text style={styles.message}>{DATABASE_UPGRADE_CHAT_MESSAGE}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
