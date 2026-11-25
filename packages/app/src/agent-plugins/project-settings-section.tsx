import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { openSettingsSection } from "@/navigation/settings-navigation";
import { settingsStyles } from "@/styles/settings";
import { isLoaded, isPlugin, pluginLabel } from "./describe";
import { SettingsPluginRow } from "./settings-section";
import { useAgentPlugins } from "./use-agent-plugins";

/**
 * Project settings → Claude Code and Codex: this project's instruction file and plugins, each
 * switched on or off on its own. An undecided plugin shows as off until the user decides, here or
 * in the line below the composer; an undecided instruction file shows as on, since it loads.
 */
export function ProjectPluginsSettings({
  serverId,
  repoRoot,
}: {
  serverId: string;
  repoRoot: string;
}) {
  const { t } = useTranslation();
  const { status, error, refetch, save, isSaving } = useAgentPlugins({ serverId, cwd: repoRoot });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const project = status?.project ?? null;
  const projectRoot = project?.projectRoot ?? null;
  const instructions = project?.plugins.filter((plugin) => !isPlugin(plugin)) ?? [];
  const plugins = project?.plugins.filter(isPlugin) ?? [];
  const hasNative = (project?.nativeSkills.length ?? 0) > 0;

  const toggle = useCallback(
    (plugin: AgentPlugin) => {
      if (!projectRoot) return;
      const on = !isLoaded(plugin);
      setToggleError(null);
      save({
        scope: { kind: "project", projectRoot },
        enabled: on ? [plugin.id] : [],
        disabled: on ? [] : [plugin.id],
      }).catch(() =>
        setToggleError(t("agentPlugins.settings.toggleFailed", { name: pluginLabel(plugin, t) })),
      );
    },
    [projectRoot, save, t],
  );
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const manageGlobal = useCallback(() => openSettingsSection("agent-plugins"), []);
  const globalOn =
    status?.global.plugins.filter((plugin) => isPlugin(plugin) && plugin.state === "on").length ??
    0;
  // The global plugins belong to the whole group, so the pointer to them sits on the group's
  // header like the Shortcuts "Reset all" action, not under the last card where it reads as its caption.
  const hasStatus = status !== null && status !== undefined;
  const globalPointer = useMemo(
    () =>
      hasStatus ? (
        <View style={styles.globalPointer}>
          {globalOn > 0 ? (
            <Text style={styles.globalCount}>
              {t("agentPlugins.sheet.globalIncluded", { count: globalOn })}
            </Text>
          ) : null}
          <Button variant="ghost" onPress={manageGlobal} testID="project-plugins-manage-global">
            {t("agentPlugins.sheet.manageGlobal")}
          </Button>
        </View>
      ) : undefined,
    [hasStatus, globalOn, manageGlobal, t],
  );

  return (
    <SettingsGroup
      title={t("settings.sections.agentPlugins")}
      info={t("agentPlugins.project.info")}
      trailing={globalPointer}
      testID="project-plugins"
    >
      {error ? (
        <Alert
          variant="error"
          title={t("agentPlugins.settings.loadFailed")}
          description={error.message}
        >
          <Button variant="outline" onPress={retry}>
            {t("agentPlugins.settings.retry")}
          </Button>
        </Alert>
      ) : null}
      <InstructionsSection entries={instructions} disabled={isSaving} onToggle={toggle} />
      {project ? (
        <SettingsSection title={t("agentPlugins.settings.sectionTitle")} flush={!hasNative}>
          <SettingsCard testID="project-plugins-list">
            {plugins.length === 0 ? (
              <SettingsRow label={t("agentPlugins.project.empty")} />
            ) : (
              plugins.map((plugin) => (
                <SettingsPluginRow
                  key={plugin.id}
                  plugin={plugin}
                  disabled={isSaving}
                  onToggle={toggle}
                />
              ))
            )}
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {project && hasNative ? (
        <SettingsSection title={t("agentPlugins.sheet.alreadyAvailable")} flush>
          <SettingsCard>
            <SettingsRow
              label={project.nativeSkills.join(", ")}
              hint={t("agentPlugins.sheet.alreadyAvailableHint")}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {toggleError ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {toggleError}
        </Text>
      ) : null}
    </SettingsGroup>
  );
}

/** The project's instruction file, switched rather than imported, under its own heading. */
function InstructionsSection({
  entries,
  disabled,
  onToggle,
}: {
  entries: AgentPlugin[];
  disabled: boolean;
  onToggle: (plugin: AgentPlugin) => void;
}) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <SettingsSection
      title={t("agentPlugins.instructions.projectSectionTitle")}
      testID="project-plugins-instructions"
    >
      <SettingsCard>
        {entries.map((entry) => (
          <SettingsPluginRow
            key={entry.id}
            plugin={entry}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  globalPointer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  globalCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
