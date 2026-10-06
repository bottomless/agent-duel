import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { WorkspaceFilesRecoveryBanner } from "@/screens/workspace/workspace-route-state-views";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";

type WorkspaceFilesState = NonNullable<WorkspaceDescriptor["filesState"]>;

export function WorkspaceFilesUnavailableState({
  filesState,
  recovery,
  onRecover,
  onRetryInspection,
}: {
  filesState: WorkspaceFilesState;
  recovery: WorkspaceRecoveryModel;
  onRecover: () => void;
  onRetryInspection: () => void;
}) {
  return (
    <View style={styles.container} testID="workspace-files-unavailable-state">
      <View style={styles.banner}>
        <WorkspaceFilesRecoveryBanner
          filesState={filesState}
          recovery={recovery}
          onRecover={onRecover}
          onRetryInspection={onRetryInspection}
        />
      </View>
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
  // The conversation's own measure, so the notice sits where a chat's banner
  // would and does not stretch across a wide pane.
  banner: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
}));
