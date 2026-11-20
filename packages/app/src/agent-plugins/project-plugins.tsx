import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPlugin } from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { openSettingsSection } from "@/navigation/settings-navigation";
import { settingsStyles } from "@/styles/settings";
import { bannerItem, bannerTitle } from "./describe";
import { AgentPluginsReviewSheet, type AgentPluginsDecision } from "./review-sheet";
import { isSelectable, useAgentPlugins, type AgentPluginsController } from "./use-agent-plugins";

interface ProjectPluginsProps {
  serverId: string;
  cwd: string;
}

function basename(directory: string): string {
  return directory.split(/[\\/]/).findLast(Boolean) ?? directory;
}

function pendingPlugins(controller: AgentPluginsController): AgentPlugin[] {
  return (controller.status?.project?.plugins ?? []).filter(
    (plugin) => plugin.state === "pending" && isSelectable(plugin),
  );
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
  const globalOn = status?.global.plugins.filter((plugin) => plugin.state === "on").length ?? 0;
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
 * Above the composer while the project has plugins the user has not decided on. Import takes them
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
    <View style={styles.banner}>
      <Alert
        variant={failed ? "error" : "info"}
        title={bannerTitle(pending, t)}
        description={failed ? t("agentPlugins.banner.failed") : names}
        testID="agent-plugins-banner"
      >
        <View style={styles.actions}>
          <Button
            variant="outline"
            onPress={dismiss}
            loading={running === "dismiss"}
            disabled={busy}
          >
            {t("agentPlugins.banner.dismiss")}
          </Button>
          <Button
            variant="outline"
            onPress={openReview}
            disabled={busy}
            testID="agent-plugins-banner-review"
          >
            {t("agentPlugins.banner.review")}
          </Button>
          <Button
            variant="outline"
            onPress={importAll}
            loading={running === "import"}
            disabled={busy}
            testID="agent-plugins-banner-import"
          >
            {t("agentPlugins.banner.import")}
          </Button>
        </View>
      </Alert>
      <ProjectPluginsSheet controller={controller} visible={reviewing} onClose={closeReview} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    marginBottom: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  footnote: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
