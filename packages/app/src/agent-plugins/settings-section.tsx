import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { isLoaded, isPlugin, pluginLabel } from "./describe";
import { GlobalPluginsSheet } from "./global-sheet";
import { PluginRow } from "./review-sheet";
import { useAgentPlugins } from "./use-agent-plugins";

/**
 * Settings → Instructions, skills and MCP: the user's own instruction files, switched any time,
 * and the global plugins, managed here after the first review. Project plugins are managed in
 * each project's settings.
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
      const on = !isLoaded(plugin);
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

  const instructions = status?.global.plugins.filter((plugin) => !isPlugin(plugin)) ?? [];
  const plugins = status?.global.plugins.filter(isPlugin) ?? [];
  const hasInstructions = instructions.length > 0;

  return (
    <>
      {/* The user's own instruction files are switched, not imported, so they get their own
          heading rather than sitting in the plugin list. Scan again rescans both. */}
      {hasInstructions ? (
        <SettingsSection
          title={t("agentPlugins.instructions.sectionTitle")}
          info={t("agentPlugins.instructions.info")}
          trailing={scanButton}
          testID="agent-plugins-instructions"
        >
          <SettingsCard>
            {instructions.map((entry) => (
              <SettingsPluginRow
                key={entry.id}
                plugin={entry}
                // Off, never pending, so it switches before the plugins are reviewed.
                disabled={isSaving}
                onToggle={toggle}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={t("agentPlugins.settings.sectionTitle")}
        info={t("agentPlugins.description")}
        trailing={hasInstructions ? undefined : scanButton}
        testID="agent-plugins-settings"
      >
        {/* A failed Scan again keeps the last list, so its error shows above it. */}
        {error ? (
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
        {status && !status.global.reviewed && plugins.length > 0 ? (
          <Alert variant="info" title={t("agentPlugins.settings.notReviewed")}>
            <Button variant="outline" onPress={openReview} testID="agent-plugins-settings-review">
              {t("agentPlugins.settings.review")}
            </Button>
          </Alert>
        ) : null}
        {status ? (
          <SettingsCard testID="agent-plugins-settings-list">
            {plugins.length === 0 ? (
              <SettingsRow label={t("agentPlugins.settings.empty")} />
            ) : (
              plugins.map((plugin) => (
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
    </>
  );
}

export function SettingsPluginRow({
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
      checked={isLoaded(plugin)}
      disabled={disabled}
      onToggle={handleToggle}
    />
  );
}
