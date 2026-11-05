import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { databaseUpgradeNotice } from "@/utils/database-upgrade-notice";

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
    if (!session || !agentId || !databaseUpgradeNotice([session])) return false;
    const status = selectAgentTimelineState(session, agentId).status;
    return status !== "synced" && status !== "painted";
  });

  // Keep lookups unmounted until ready, so a transient missing session cannot become a load error.
  // Like the sidebar upgrade notice, this maintenance text is currently English in every locale.
  if (waiting) {
    return (
      <View style={styles.container} testID="database-upgrade-chat">
        <Text style={styles.message}>
          Upgrading your database. This chat opens when the upgrade finishes.
        </Text>
      </View>
    );
  }
  return children;
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
