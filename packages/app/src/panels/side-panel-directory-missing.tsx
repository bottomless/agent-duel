import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

/**
 * Shown by a side panel tab while the workspace has no directory to browse.
 * Cleanup removes that directory on purpose and keeps it restorable, so it
 * reads as a reclaimed workspace rather than a missing one.
 */
export function SidePanelDirectoryMissing() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = usePaneContext();
  const filesCleaned =
    useWorkspaceFields(
      serverId,
      workspaceId,
      (workspace) => workspace.filesState !== undefined && workspace.filesState !== "available",
    ) ?? false;
  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {filesCleaned ? t("panels.file.directoryCleaned") : t("panels.file.directoryMissing")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
