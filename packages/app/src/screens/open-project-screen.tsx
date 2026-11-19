import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { FolderOpen } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useHosts, useHostRuntimeLastError } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { useHeaderMetrics, useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { RecentProjectsSection, useRecentProjects } from "@/screens/recent-projects-section";

const WINDOW_CONTENT_DATASET = { "window-content": "" };

export function OpenProjectScreen() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const openDesktopAgentList = usePanelStore((s) => s.openDesktopAgentList);
  const openProjectPicker = useOpenAddProject();

  const isCompactLayout = useIsCompactFormFactor();
  const { innerHeight, topPadding } = useHeaderMetrics();
  // Room for the header's height at the bottom too, so the tiles sit centred in the window.
  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: topPadding + innerHeight + SPACING[6] }],
    [innerHeight, topPadding],
  );

  useEffect(() => {
    if (!isCompactLayout) {
      openDesktopAgentList();
    }
  }, [isCompactLayout, openDesktopAgentList]);

  const handleOpenPicker = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  // Recent projects are read from this computer's tools, so only the local daemon can offer them.
  const localServerId = useLocalDaemonServerId();
  const recent = useRecentProjects(localServerId);

  const hostErrors = hosts.map((host) => (
    <HostError key={host.serverId} serverId={host.serverId} label={host.label} />
  ));

  const renderAddProjectTile = (wide: boolean) => (
    <HomeTile
      icon={FolderOpen}
      title={t("openProject.tiles.addProject.title")}
      description={t("openProject.tiles.addProject.description")}
      onPress={handleOpenPicker}
      testID="open-project-submit"
      accent
      wide={wide}
    />
  );

  if (localServerId) {
    // Anchored to the top rather than centred, so the list arriving or turning out empty never
    // moves the tile.
    return (
      <View style={styles.container}>
        <MenuHeader borderless />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.recentScrollContent}
          dataSet={WINDOW_CONTENT_DATASET}
        >
          {/* One column, so the tile and the list share their edges. */}
          <View style={styles.column}>
            {hostErrors}
            {renderAddProjectTile(true)}
            <View style={styles.recent}>
              <RecentProjectsSection
                serverId={localServerId}
                projects={recent.isError ? [] : recent.data}
              />
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader borderless />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        dataSet={WINDOW_CONTENT_DATASET}
      >
        <View style={contentStyle}>
          {hostErrors}
          <View style={styles.tiles}>{renderAddProjectTile(false)}</View>
        </View>
      </ScrollView>
    </View>
  );
}

function HostError({ serverId, label }: { serverId: string; label: string }) {
  const error = useHostRuntimeLastError(serverId);
  return error ? (
    <Text accessibilityRole="alert" style={styles.hostError}>
      {label}: {error}
    </Text>
  ) : null;
}

interface HomeTileProps {
  icon: ComponentType<{ size: number; color: string }>;
  title: string;
  description: string;
  onPress: () => void;
  testID?: string;
  accent?: boolean;
  /**
   * Spans the column as a row, matching the recent projects card below it: its 16px icon sits on
   * the rows' icon rail, so the title starts where theirs do.
   */
  wide?: boolean;
}

function HomeTile({
  icon: Icon,
  title,
  description,
  onPress,
  testID,
  accent,
  wide,
}: HomeTileProps) {
  // useUnistyles is acceptable here: leaf component, off the hot path (home screen renders once).
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const iconColor = accent ? theme.colors.accent : theme.colors.foregroundMuted;

  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.tile,
      wide && styles.tileWide,
      hovered && styles.tileHovered,
      pressed && styles.tilePressed,
    ],
    [hovered, wide],
  );

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      testID={testID}
      style={pressableStyle}
    >
      <Icon size={wide ? 16 : 20} color={iconColor} />
      <View style={wide ? styles.tileTextWide : styles.tileText}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  recentScrollContent: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[6],
    paddingTop: { xs: theme.spacing[6], md: theme.spacing[16] },
    paddingBottom: theme.spacing[12],
  },
  content: {
    position: "relative",
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: { xs: "flex-start", md: "center" },
    alignItems: "center",
    gap: 0,
    padding: theme.spacing[6],
    paddingTop: { xs: theme.spacing[12], md: theme.spacing[6] },
  },
  column: {
    width: "100%",
    maxWidth: 560,
    marginTop: { xs: theme.spacing[6], md: theme.spacing[12] },
  },
  recent: {
    marginTop: theme.spacing[12],
  },
  hostError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    maxWidth: 452,
    textAlign: "center",
  },
  tiles: {
    marginTop: { xs: theme.spacing[6], md: theme.spacing[12] },
    width: "100%",
    maxWidth: 220,
    flexDirection: "row",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  tile: {
    width: { xs: "100%", md: 220 },
    minHeight: { xs: 0, md: 132 },
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    gap: theme.spacing[3],
  },
  tileWide: {
    width: "100%",
    minHeight: 0,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.lg,
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  tilePressed: {
    opacity: 0.85,
  },
  tileText: {
    gap: theme.spacing[1],
  },
  tileTextWide: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  tileTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tileDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
  },
}));
