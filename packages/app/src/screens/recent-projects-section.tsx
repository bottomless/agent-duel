import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { RecentProject, RecentProjectSource } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ProjectIconView } from "@/components/project-icon-view";
import { useFetchQuery } from "@/data/query";
import { getOpenProjectFailureReason } from "@/hooks/open-project";
import { useOpenProject } from "@/hooks/use-open-project";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { shortenPath } from "@/utils/shorten-path";
import { formatTimeAgo } from "@/utils/time";

const MutedChevron = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const MutedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** Rows shown before Show all; enough to reach the projects in use this week. */
const COLLAPSED_COUNT = 6;
const STALE_TIME_MS = 60_000;

// Proper nouns: the tools' own names, the same in every language.
const SOURCE_LABELS: Record<RecentProjectSource, string> = {
  claude: "Claude Code",
  codex: "Codex",
  vscode: "VS Code",
};

export function useRecentProjects(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  return useFetchQuery({
    queryKey: ["recent-projects", serverId],
    dataShape: "list",
    enabled: Boolean(serverId && client && isConnected),
    staleTimeMs: STALE_TIME_MS,
    queryFn: async () => {
      if (!client) return [];
      return (await client.listRecentProjects()).projects;
    },
  });
}

interface RecentProjectsSectionProps {
  serverId: string;
  projects: readonly RecentProject[] | undefined;
}

/**
 * Projects the user worked on in Claude Code, Codex or VS Code on this computer, each a click away
 * from a new chat. Shown on the first screen, under Add a project; hidden when none are found.
 */
export function RecentProjectsSection({ serverId, projects }: RecentProjectsSectionProps) {
  const { t } = useTranslation();
  const openProject = useOpenProject(serverId);
  const [expanded, setExpanded] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const open = useCallback(
    async (project: RecentProject) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setOpeningPath(project.path);
      setError(null);
      try {
        const result = await openProject(project.path);
        if (result.ok) {
          router.push(
            buildNewWorkspaceRoute({
              serverId,
              projectId: result.project.projectId,
              sourceDirectory: result.project.projectRootPath,
              displayName: result.project.projectDisplayName,
            }),
          );
          return;
        }
        setError(
          getOpenProjectFailureReason(result) === "directory_not_found"
            ? t("openProject.recent.notFound")
            : t("openProject.recent.openFailed"),
        );
      } catch {
        setError(t("openProject.recent.openFailed"));
      } finally {
        inFlight.current = false;
        setOpeningPath(null);
      }
    },
    [openProject, serverId, t],
  );

  const showAll = useCallback(() => setExpanded(true), []);

  if (projects?.length === 0) return null;
  const all = projects ?? [];
  const visible = expanded ? all : all.slice(0, COLLAPSED_COUNT);
  const hidden = all.length - visible.length;

  return (
    <SettingsSection title={t("openProject.recent.title")} testID="recent-projects">
      <View style={settingsStyles.card}>
        {projects ? (
          visible.map((project, index) => (
            <RecentProjectRow
              key={project.path}
              project={project}
              isFirst={index === 0}
              isOpening={openingPath === project.path}
              onOpen={open}
            />
          ))
        ) : (
          <View style={[settingsStyles.row, styles.loadingRow]}>
            <MutedSpinner size={14} />
            <Text style={styles.loadingText}>{t("openProject.recent.loading")}</Text>
          </View>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={showAll}
          style={styles.showAll}
          testID="recent-projects-show-all"
        >
          {t("openProject.recent.showAll", { count: all.length })}
        </Button>
      ) : null}
    </SettingsSection>
  );
}

interface RecentProjectRowProps {
  project: RecentProject;
  isFirst: boolean;
  isOpening: boolean;
  onOpen: (project: RecentProject) => void;
}

function RecentProjectRow({ project, isFirst, isOpening, onOpen }: RecentProjectRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpen(project), [onOpen, project]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst],
  );
  const sources = project.sources.map((source) => SOURCE_LABELS[source]).join(" · ");

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("openProject.recent.openLabel", { name: project.name })}
      testID={`recent-project-${project.path}`}
    >
      <View style={styles.leading}>
        <ProjectIconView
          iconDataUri={null}
          initial={project.name.charAt(0).toUpperCase() || "?"}
          projectViewKey={project.path}
          size={16}
          textStyle={styles.iconFallbackText}
        />
      </View>
      <View style={styles.main}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {project.name}
        </Text>
        <Text style={styles.path} numberOfLines={1}>
          {shortenPath(project.path)}
        </Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.metaText} numberOfLines={1}>
          {sources}
        </Text>
        <Text style={styles.metaText} numberOfLines={1}>
          {formatTimeAgo(new Date(project.lastUsedAt))}
        </Text>
      </View>
      {/* One fixed slot for the chevron and the spinner that replaces it, so the row never shifts. */}
      <View style={styles.trailing}>
        {isOpening ? <MutedSpinner size={14} /> : <MutedChevron />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  leading: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconFallbackText: {
    fontSize: theme.fontSize.xs,
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  meta: {
    alignItems: "flex-end",
    flexShrink: 0,
    maxWidth: "40%",
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  trailing: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  showAll: {
    alignSelf: "center",
    marginTop: theme.spacing[2],
  },
}));
