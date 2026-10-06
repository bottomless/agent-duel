import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { getDesktopHost, isElectronRuntimeMac } from "@/desktop/host";
import { settingsStyles } from "@/styles/settings";

const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

export function DesktopNotificationsSection() {
  const { t } = useTranslation();
  const [settingsState, setSettingsState] = useState<"idle" | "opening" | "error">("idle");
  const handleOpenSettings = useCallback(async () => {
    setSettingsState("opening");
    try {
      const openSettings = getDesktopHost()?.notification?.openSettings;
      if (!openSettings) throw new Error("Notification settings bridge unavailable");
      await openSettings();
      setSettingsState("idle");
    } catch {
      setSettingsState("error");
    }
  }, []);
  const { settings, isLoading, isSaving, error, updateSettings } = useDesktopSettings();
  const {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    testNotificationState,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  } = useDesktopPermissions();

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const handlePlaySoundChange = useCallback(
    (playSound: boolean) => {
      void updateSettings({ notifications: { playSound } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const handleAgentFinishedChange = useCallback(
    (agentFinished: boolean) => {
      void updateSettings({ notifications: { agentFinished } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );
  const handleBattleReadyChange = useCallback(
    (battleReady: boolean) => {
      void updateSettings({ notifications: { battleReady } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );
  const settingsDisabled = isLoading || isSaving || error !== null;

  const handleSendTestNotification = useCallback(() => {
    void sendTestNotification();
  }, [sendTestNotification]);

  const isPermissionBusy = isRefreshing || requestingPermission !== null;
  const isSendingTestNotification = testNotificationState.status === "sending";
  const refreshIcon = useMemo(() => <ThemedRotateCw />, []);
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isPermissionBusy}
        accessibilityLabel={t("settings.notifications.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [handleRefreshPress, isPermissionBusy, isRefreshing, refreshIcon, t],
  );
  const handleRequestNotifications = useCallback(() => {
    void requestPermission("notifications");
  }, [requestPermission]);
  const permissionAction = useMemo(() => {
    if (!isElectronRuntimeMac()) return null;
    if (snapshot?.notifications.state === "prompt") {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={isPermissionBusy}
          onPress={handleRequestNotifications}
        >
          {t(
            requestingPermission === "notifications"
              ? "settings.notifications.requestingPermission"
              : "settings.notifications.allowNotifications",
          )}
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        onPress={handleOpenSettings}
        disabled={settingsState === "opening"}
      >
        {t(
          settingsState === "opening"
            ? "settings.notifications.openingSettings"
            : "settings.notifications.openSystemSettings",
        )}
      </Button>
    );
  }, [
    snapshot?.notifications.state,
    isPermissionBusy,
    handleRequestNotifications,
    requestingPermission,
    handleOpenSettings,
    settingsState,
    t,
  ]);
  if (!isDesktopApp) {
    return null;
  }

  const canSendTestNotification =
    snapshot?.notifications.state === "granted" ||
    (!isElectronRuntimeMac() && snapshot?.notifications.state === "system-managed");

  return (
    <SettingsSection title={t("settings.notifications.title")} trailing={refreshButton}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.permission")}</Text>
            <Text style={settingsStyles.rowHint}>
              {snapshot?.notifications.detail ?? t("desktop.permissions.empty.notifications")}
            </Text>
          </View>
          {permissionAction}
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.agentFinished")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.notifications.agentFinishedHint")}
            </Text>
          </View>
          <Switch
            value={settings.notifications.agentFinished}
            onValueChange={handleAgentFinishedChange}
            disabled={settingsDisabled}
            accessibilityLabel={t("settings.notifications.agentFinished")}
            testID="desktop-notifications-agent-finished-switch"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.battleReady")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.notifications.battleReadyHint")}
            </Text>
          </View>
          <Switch
            value={settings.notifications.battleReady}
            onValueChange={handleBattleReadyChange}
            disabled={settingsDisabled}
            accessibilityLabel={t("settings.notifications.battleReady")}
            testID="desktop-notifications-battle-ready-switch"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.playSound")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.notifications.playSoundHint")}</Text>
          </View>
          <Switch
            value={settings.notifications.playSound}
            onValueChange={handlePlaySoundChange}
            disabled={settingsDisabled}
            accessibilityLabel={t("settings.notifications.playSound")}
            testID="desktop-notifications-play-sound-switch"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.test")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.notifications.testHint")}</Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleSendTestNotification}
            disabled={!canSendTestNotification || isPermissionBusy || isSendingTestNotification}
          >
            {isSendingTestNotification
              ? t("settings.notifications.sending")
              : t("settings.notifications.send")}
          </Button>
        </View>
      </View>
      {settingsState === "error" ? (
        <Alert
          variant="error"
          title={t("settings.notifications.openSettingsFailed")}
          description={t("settings.notifications.openSettingsManually")}
          testID="desktop-notifications-settings-error"
        />
      ) : null}
      {testNotificationState.status === "success" ? (
        <Alert
          variant="info"
          title={t("settings.notifications.sentTitle")}
          description={t("settings.notifications.sentDescription")}
          testID="desktop-notifications-test-success"
        />
      ) : null}
      {testNotificationState.status === "error" ? (
        <Alert
          variant="error"
          title={t("settings.notifications.sendFailedTitle")}
          description={testNotificationState.message}
          testID="desktop-notifications-test-error"
        />
      ) : null}
    </SettingsSection>
  );
}
