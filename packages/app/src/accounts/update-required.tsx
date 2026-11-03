import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  useDesktopAppUpdater,
  type DesktopAppUpdateStatus,
} from "@/desktop/updates/use-desktop-app-updater";
import { openExternalUrl } from "@/utils/open-external-url";

const LATEST_RELEASE_URL = "https://github.com/bottomless/agent-duel/releases/latest";

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  panel: {
    width: "100%",
    maxWidth: 380,
    gap: theme.spacing[4],
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

type UpdateProgress = "ready" | "downloading" | "none";

function updateProgress(updater: {
  isDesktopApp: boolean;
  status: DesktopAppUpdateStatus;
  isInstalling: boolean;
}): UpdateProgress {
  if (!updater.isDesktopApp) return "none";
  if (updater.status === "available" || updater.isInstalling) return "ready";
  if (updater.status === "pending" || updater.status === "checking") return "downloading";
  return "none";
}

function updateDetail(progress: UpdateProgress): string {
  if (progress === "ready") return "This version is no longer supported. The new version is ready.";
  if (progress === "downloading") {
    return "This version is no longer supported. Downloading the new version...";
  }
  return "This version is no longer supported. Download the latest version to keep battling.";
}

/**
 * Shown in place of the app when the control plane refuses this build. The updater checks on
 * mount, so an update that is already downloaded installs from here; otherwise the release page is
 * the way out.
 */
export function UpdateRequired() {
  const { t } = useTranslation();
  const updater = useDesktopAppUpdater();
  const { isInstalling, installUpdate } = updater;
  const progress = updateProgress(updater);

  const install = useCallback(() => {
    void installUpdate();
  }, [installUpdate]);
  const download = useCallback(() => {
    void openExternalUrl(LATEST_RELEASE_URL);
  }, []);

  return (
    <View style={styles.root} testID="update-required">
      <View style={styles.panel}>
        <Text style={styles.title}>Update Agent Duel to continue</Text>
        <Text style={styles.detail}>{updateDetail(progress)}</Text>
        {progress === "ready" ? (
          <Button
            variant="default"
            onPress={install}
            disabled={isInstalling}
            testID="update-required-install"
          >
            {t(
              isInstalling
                ? "desktop.updates.callout.installingAction"
                : "desktop.updates.callout.installAndRestart",
            )}
          </Button>
        ) : null}
        {progress === "ready" ? null : (
          <Button variant="default" onPress={download} testID="update-required-download">
            Download the latest version
          </Button>
        )}
      </View>
    </View>
  );
}
