import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Puzzle } from "lucide-react-native";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { openSettingsSection } from "@/navigation/settings-navigation";
import { settingsStyles } from "@/styles/settings";
import { bannerItem, bannerTitle, isPlugin } from "./describe";
import { AgentPluginsReviewSheet, type AgentPluginsDecision } from "./review-sheet";
import { useAgentPlugins, type AgentPluginsController } from "./use-agent-plugins";

interface ProjectPluginsProps {
  serverId: string;
  cwd: string;
}

function basename(directory: string): string {
  return directory.split(/[\\/]/).findLast(Boolean) ?? directory;
}

function pendingPlugins(controller: AgentPluginsController): AgentPlugin[] {
  return (controller.status?.project?.plugins ?? []).filter((plugin) => plugin.state === "pending");
}

/** The project's plugins with a pointer to the global ones, which are managed in Settings. */
function ProjectPluginsSheet({
  controller,
  visible,
  onClose,
}: {
  controller: AgentPluginsController;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { status, save, isSaving } = controller;
  const project = status?.project ?? null;
  const projectRoot = project?.projectRoot ?? "";
  const handleSave = useCallback(
    (decision: AgentPluginsDecision) =>
      save({ scope: { kind: "project", projectRoot }, ...decision }),
    [projectRoot, save],
  );
  const manageGlobal = useCallback(() => {
    onClose();
    openSettingsSection("agent-plugins");
  }, [onClose]);
  const globalOn =
    status?.global.plugins.filter((plugin) => isPlugin(plugin) && plugin.state === "on").length ??
    0;
  const footnote = useMemo(
    () => (
      <View style={styles.footnote}>
        {globalOn > 0 ? (
          <Text style={settingsStyles.rowHint}>
            {t("agentPlugins.sheet.globalIncluded", { count: globalOn })}
          </Text>
        ) : null}
        <Button variant="ghost" onPress={manageGlobal} testID="agent-plugins-manage-global">
          {t("agentPlugins.sheet.manageGlobal")}
        </Button>
      </View>
    ),
    [globalOn, manageGlobal, t],
  );
  if (!project) return null;
  return (
    <AgentPluginsReviewSheet
      visible={visible}
      title={t("agentPlugins.sheet.projectTitle", { project: basename(project.projectRoot) })}
      hint={t("agentPlugins.sheet.projectHint")}
      plugins={project.plugins}
      nativeSkills={project.nativeSkills}
      footnote={footnote}
      isSaving={isSaving}
      onSave={handleSave}
      onClose={onClose}
      testID="agent-plugins-project-sheet"
    />
  );
}

type BannerAction = "import" | "dismiss";

/**
 * Below the composer while the project has plugins the user has not decided on. Import takes them
 * all, as the sheet's default does; Not now turns them off until something new turns up.
 */
export function AgentPluginsBanner({ serverId, cwd }: ProjectPluginsProps) {
  const { t } = useTranslation();
  const controller = useAgentPlugins({ serverId, cwd });
  const [reviewing, setReviewing] = useState(false);
  const [running, setRunning] = useState<BannerAction | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = pendingPlugins(controller);
  const projectRoot = controller.status?.project?.projectRoot ?? null;
  const { save } = controller;

  const decide = useCallback(
    (action: BannerAction) => {
      if (!projectRoot) return;
      const ids = pending.map((plugin) => plugin.id);
      setRunning(action);
      setFailed(false);
      save({
        scope: { kind: "project", projectRoot },
        enabled: action === "import" ? ids : [],
        disabled: action === "dismiss" ? ids : [],
      })
        .catch(() => setFailed(true))
        .finally(() => setRunning(null));
    },
    [pending, projectRoot, save],
  );
  const importAll = useCallback(() => decide("import"), [decide]);
  const dismiss = useCallback(() => decide("dismiss"), [decide]);
  const openReview = useCallback(() => setReviewing(true), []);
  const closeReview = useCallback(() => setReviewing(false), []);

  if (pending.length === 0) return null;
  const names = pending.map((plugin) => bannerItem(plugin, t)).join(", ");
  const busy = running !== null;
  return (
    <View style={styles.banner} testID="agent-plugins-banner">
      <Puzzle size={14} color={styles.icon.color} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={failed ? styles.error : styles.title}>
          {failed ? t("agentPlugins.banner.failed") : bannerTitle(pending, t)}
        </Text>
        {failed ? null : ` · ${names}`}
      </Text>
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          onPress={importAll}
          loading={running === "import"}
          disabled={busy}
          testID="agent-plugins-banner-import"
        >
          {t("agentPlugins.banner.import")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={openReview}
          disabled={busy}
          testID="agent-plugins-banner-review"
        >
          {t("agentPlugins.banner.review")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={dismiss}
          loading={running === "dismiss"}
          disabled={busy}
        >
          {t("agentPlugins.banner.dismiss")}
        </Button>
      </View>
      <ProjectPluginsSheet controller={controller} visible={reviewing} onClose={closeReview} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Lines the icon up with the composer's text and the last button with its send button.
    paddingLeft: theme.spacing[7],
    paddingRight: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  title: {
    color: theme.colors.foreground,
  },
  error: {
    color: theme.colors.destructive,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  footnote: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
