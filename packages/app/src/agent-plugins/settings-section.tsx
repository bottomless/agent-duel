import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { pluginLabel } from "./describe";
import { GlobalPluginsSheet } from "./global-sheet";
import { PluginRow } from "./review-sheet";
import { useAgentPlugins } from "./use-agent-plugins";

/**
 * Settings → Plugins: the global plugins, managed here after the first review. Project plugins are
 * managed from the chat's composer.
 */
export function AgentPluginsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const controller = useAgentPlugins({ serverId, cwd: null });
  const { status, error, isFetching, refetch, save, isSaving } = controller;
  const [reviewing, setReviewing] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const openReview = useCallback(() => setReviewing(true), []);
  const closeReview = useCallback(() => setReviewing(false), []);
  const scan = useCallback(() => {
    void refetch();
  }, [refetch]);

  const toggle = useCallback(
    (plugin: AgentPlugin) => {
      const on = plugin.state !== "on";
      setToggleError(null);
      save({
        scope: { kind: "global" },
        enabled: on ? [plugin.id] : [],
        disabled: on ? [] : [plugin.id],
      }).catch(() =>
        setToggleError(t("agentPlugins.settings.toggleFailed", { name: pluginLabel(plugin, t) })),
      );
    },
    [save, t],
  );

  const scanButton = useMemo(
    () => (
      <Button variant="outline" onPress={scan} loading={isFetching} testID="agent-plugins-scan">
        {isFetching ? t("agentPlugins.settings.scanning") : t("agentPlugins.settings.scan")}
      </Button>
    ),
    [isFetching, scan, t],
  );

  return (
    <SettingsSection
      title={t("agentPlugins.settings.sectionTitle")}
      trailing={scanButton}
      testID="agent-plugins-settings"
    >
      <Text style={[settingsStyles.rowHint, styles.description]}>
        {t("agentPlugins.description")}
      </Text>
      {error && !status ? (
        <Alert
          variant="error"
          title={t("agentPlugins.settings.loadFailed")}
          description={error.message}
        >
          <Button variant="outline" onPress={scan}>
            {t("agentPlugins.settings.retry")}
          </Button>
        </Alert>
      ) : null}
      {status && !status.global.reviewed && status.global.plugins.length > 0 ? (
        <Alert variant="info" title={t("agentPlugins.settings.notReviewed")}>
          <Button variant="outline" onPress={openReview} testID="agent-plugins-settings-review">
            {t("agentPlugins.settings.review")}
          </Button>
        </Alert>
      ) : null}
      {status ? (
        <SettingsCard testID="agent-plugins-settings-list">
          {status.global.plugins.length === 0 ? (
            <SettingsRow label={t("agentPlugins.settings.empty")} />
          ) : (
            status.global.plugins.map((plugin) => (
              <SettingsPluginRow
                key={plugin.id}
                plugin={plugin}
                // Before the first review every plugin is pending; the sheet decides them together.
                disabled={isSaving || !status.global.reviewed}
                onToggle={toggle}
              />
            ))
          )}
        </SettingsCard>
      ) : null}
      {toggleError ? (
        <View>
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {toggleError}
          </Text>
        </View>
      ) : null}
      <GlobalPluginsSheet controller={controller} visible={reviewing} onClose={closeReview} />
    </SettingsSection>
  );
}

function SettingsPluginRow({
  plugin,
  disabled,
  onToggle,
}: {
  plugin: AgentPlugin;
  disabled: boolean;
  onToggle: (plugin: AgentPlugin) => void;
}) {
  const handleToggle = useCallback(() => onToggle(plugin), [onToggle, plugin]);
  return (
    <PluginRow
      plugin={plugin}
      checked={plugin.state === "on"}
      disabled={disabled}
      onToggle={handleToggle}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  description: {
    marginBottom: theme.spacing[2],
  },
}));
