import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  FolderTree,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { agentLabel } from "@/arena/environment";
import type { Theme } from "@/styles/theme";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { SidePanelLaunchers } from "@/screens/workspace/workspace-desktop-tabs-row";

const ThemedGitCompareArrows = withUnistyles(GitCompareArrows);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SidePanelLauncherProps {
  launchers: SidePanelLaunchers;
  showCreateBrowserTab: boolean;
  onOpenTab: (target: WorkspaceTabTarget) => void;
  onCreateTerminal: (input: { paneId?: string }) => void;
  onCreateBrowser: (input: { paneId?: string }) => void;
  arenaSeatSides: readonly ArenaSide[];
  onCreateArenaSeatTerminal: (side: ArenaSide) => void;
}

interface LauncherEntry {
  key: string;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  testID: string;
}

/**
 * What an empty side pane shows: one button per surface the side panel can
 * host, so opening the panel with nothing in it is a starting point rather than
 * a blank.
 */
export function SidePanelLauncher({
  launchers,
  showCreateBrowserTab,
  onOpenTab,
  onCreateTerminal,
  onCreateBrowser,
  arenaSeatSides,
  onCreateArenaSeatTerminal,
}: SidePanelLauncherProps) {
  const { t } = useTranslation();
  const entries = useMemo<LauncherEntry[]>(() => {
    const next: LauncherEntry[] = [];
    if (launchers.changes) {
      next.push({
        key: "changes",
        icon: <ThemedGitCompareArrows size={16} uniProps={mutedColorMapping} />,
        label: t("workspace.tabs.actions.openChanges"),
        onPress: () => onOpenTab({ kind: "changes" }),
        testID: "workspace-side-panel-launcher-changes",
      });
    }
    if (launchers.files) {
      next.push({
        key: "files",
        icon: <ThemedFolderTree size={16} uniProps={mutedColorMapping} />,
        label: t("workspace.tabs.actions.openFiles"),
        onPress: () => onOpenTab({ kind: "files" }),
        testID: "workspace-side-panel-launcher-files",
      });
    }
    if (launchers.pullRequest) {
      next.push({
        key: "pull_request",
        icon: <ThemedGitPullRequest size={16} uniProps={mutedColorMapping} />,
        label: t("workspace.tabs.actions.openPullRequest"),
        onPress: () => onOpenTab({ kind: "pull_request" }),
        testID: "workspace-side-panel-launcher-pull-request",
      });
    }
    return next;
  }, [launchers, onOpenTab, t]);
  const hasSurfaceEntries = entries.length > 0;
  /* The same group the "+" menu lists, in the same order and always in the same shape: the
     heading and its rule are there before the chat's battle is known, so the panel does not
     rearrange itself under the reader when the seats arrive. */
  const terminalEntries = useMemo<LauncherEntry[]>(() => {
    const next: LauncherEntry[] = arenaSeatSides.map((side) => ({
      key: `terminal-${side}`,
      icon: <ThemedSquareTerminal size={16} uniProps={mutedColorMapping} />,
      label: t("workspace.tabs.actions.newTerminalSeat", { agent: agentLabel(side) }),
      onPress: () => onCreateArenaSeatTerminal(side),
      testID: `workspace-side-panel-launcher-terminal-${side}`,
    }));
    next.push({
      key: "terminal",
      icon: <ThemedSquareTerminal size={16} uniProps={mutedColorMapping} />,
      label: t("workspace.tabs.actions.newTerminalWorkspace"),
      onPress: () => onCreateTerminal({}),
      testID: "workspace-side-panel-launcher-terminal",
    });
    return next;
  }, [arenaSeatSides, onCreateArenaSeatTerminal, onCreateTerminal, t]);
  const browserEntry = useMemo<LauncherEntry>(
    () => ({
      key: "browser",
      icon: <ThemedGlobe size={16} uniProps={mutedColorMapping} />,
      label: t("workspace.tabs.actions.newBrowser"),
      onPress: () => onCreateBrowser({}),
      testID: "workspace-side-panel-launcher-browser",
    }),
    [onCreateBrowser, t],
  );

  return (
    <View style={styles.container} testID="workspace-side-panel-launcher">
      <Text style={styles.title}>{t("workspace.tabs.sidePanel.launcherTitle")}</Text>
      <View style={styles.list}>
        {entries.map((entry) => (
          <LauncherButton key={entry.key} entry={entry} />
        ))}
        <View
          style={[
            styles.terminalGroup,
            hasSurfaceEntries && styles.terminalGroupRuledAbove,
            /* Whatever follows the group is not a terminal, so it gets the rule the group got. */
            showCreateBrowserTab && styles.terminalGroupRuledBelow,
          ]}
        >
          <Text style={styles.groupTitle}>{t("workspace.tabs.actions.newTerminal")}</Text>
          {terminalEntries.map((entry) => (
            <LauncherButton key={entry.key} entry={entry} />
          ))}
        </View>
        {showCreateBrowserTab ? <LauncherButton entry={browserEntry} /> : null}
      </View>
    </View>
  );
}

function LauncherButton({ entry }: { entry: LauncherEntry }) {
  return (
    <Pressable
      testID={entry.testID}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      onPress={entry.onPress}
      style={launcherButtonStyle}
    >
      {entry.icon}
      <Text style={styles.label}>{entry.label}</Text>
    </Pressable>
  );
}

function launcherButtonStyle({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) {
  return [styles.button, (hovered || pressed) && styles.buttonHovered];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  list: {
    width: "100%",
    maxWidth: 280,
    gap: theme.spacing[1],
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  terminalGroup: {
    borderColor: theme.colors.borderAccent,
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  terminalGroupRuledAbove: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  terminalGroupRuledBelow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[3],
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
