import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { pluginLabel, pluginSummary } from "./describe";
import { isSelectable } from "./use-agent-plugins";

export interface AgentPluginsDecision {
  enabled: string[];
  disabled: string[];
}

interface AgentPluginsReviewSheetProps {
  visible: boolean;
  title: string;
  hint: string;
  plugins: readonly AgentPlugin[];
  /** Skills the engine reads from the project itself, listed so the user knows they are covered. */
  nativeSkills: readonly string[];
  /** Below the list: the project sheet's pointer to the global plugins. */
  footnote: ReactNode;
  isSaving: boolean;
  onSave: (decision: AgentPluginsDecision) => Promise<unknown>;
  onClose: () => void;
  testID: string;
}

/** Undecided plugins start checked: importing everything is the default. */
function initialChecked(plugins: readonly AgentPlugin[]): Record<string, boolean> {
  return Object.fromEntries(
    plugins.filter(isSelectable).map((plugin) => [plugin.id, plugin.state !== "off"]),
  );
}

/** Draft form state only; the decision and the import it triggers belong to the host. */
export function AgentPluginsReviewSheet({
  visible,
  title,
  hint,
  plugins,
  nativeSkills,
  footnote,
  isSaving,
  onSave,
  onClose,
  testID,
}: AgentPluginsReviewSheetProps) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(() => initialChecked(plugins));
  const [saveError, setSaveError] = useState<string | null>(null);
  const wasVisible = useRef(visible);

  // Seeded when the sheet opens, not when a background refresh hands back new plugins mid-edit.
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
    setChecked(initialChecked(plugins));
    setSaveError(null);
  }, [plugins, visible]);

  const toggle = useCallback((id: string) => {
    setChecked((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  const handleSave = useCallback(() => {
    const ids = Object.keys(checked);
    const decision = {
      enabled: ids.filter((id) => checked[id]),
      disabled: ids.filter((id) => !checked[id]),
    };
    setSaveError(null);
    onSave(decision).then(onClose, () => setSaveError(t("agentPlugins.sheet.saveFailed")));
  }, [checked, onClose, onSave, t]);

  const handleDismiss = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={handleDismiss}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          loading={isSaving}
          testID={`${testID}-save`}
        >
          {isSaving ? t("agentPlugins.sheet.importing") : t("agentPlugins.sheet.import")}
        </Button>
      </View>
    ),
    [handleDismiss, handleSave, isSaving, t, testID],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleDismiss}
      footer={footer}
      testID={testID}
    >
      <Text style={settingsStyles.rowHint}>{hint}</Text>
      <SettingsCard testID={`${testID}-list`}>
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            checked={checked[plugin.id] === true}
            disabled={isSaving}
            onToggle={toggle}
          />
        ))}
      </SettingsCard>
      {nativeSkills.length > 0 ? (
        <SettingsSection title={t("agentPlugins.sheet.alreadyAvailable")} flush>
          <SettingsCard>
            <SettingsRow
              label={nativeSkills.join(", ")}
              hint={t("agentPlugins.sheet.alreadyAvailableHint")}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {footnote}
      {saveError ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {saveError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

/** The command lines of a plugin's local MCP servers, which run on this computer. */
function localLaunches(plugin: AgentPlugin): string[] {
  return plugin.contents.mcpServers
    .map((server) => server.launch)
    .filter((launch) => launch.length > 0 && !/^https?:\/\//.test(launch));
}

export function PluginRow({
  plugin,
  checked,
  disabled,
  onToggle,
}: {
  plugin: AgentPlugin;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const handleValueChange = useCallback(() => onToggle(plugin.id), [onToggle, plugin.id]);
  const label = pluginLabel(plugin, t);
  const hint = useMemo(
    () => (
      <View>
        <Text style={settingsStyles.rowHint}>{pluginSummary(plugin, t)}</Text>
        {localLaunches(plugin).map((command) => (
          <Text key={command} style={settingsStyles.rowHint}>
            {t("agentPlugins.plugin.runs", { command })}
          </Text>
        ))}
      </View>
    ),
    [plugin, t],
  );
  const error = plugin.importError
    ? t("agentPlugins.plugin.importFailed", { reason: plugin.importError })
    : undefined;
  return (
    <SettingsRow label={label} hint={hint} error={error} testID={`agent-plugin-${plugin.id}`}>
      {isSelectable(plugin) ? (
        <Switch
          value={checked}
          onValueChange={handleValueChange}
          disabled={disabled}
          accessibilityLabel={label}
        />
      ) : null}
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
