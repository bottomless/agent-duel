import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { View } from "react-native";
import { Ellipsis, Maximize2, Minimize2, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaRun, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { agentLabel, lifecycleServiceEntries } from "./environment";
import { PaneIconAction, paneIconMenuTriggerStyle } from "./pane-icon-action";
import { PreviewButton } from "./service-indicators";
import { ServiceMenuItem } from "./services-strip";
import {
  CopyPathMenuItem,
  OpenTerminalMenuItem,
  WorktreePathLabel,
  useArenaWorktreeActions,
} from "./worktree-menu";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedMinimize2 = withUnistyles(Minimize2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The pane's running app, if it has one. The heading places it beside its actions or under them. */
export function ArenaPanePreview({
  turnId,
  side,
  run,
}: {
  turnId: string;
  side: ArenaSide;
  run: ArenaRun | undefined;
}) {
  const preview = useMemo(
    () => (run ? lifecycleServiceEntries(run) : []).find((entry) => entry.preview),
    [run],
  );
  if (!preview) return null;
  return (
    <PreviewButton turnId={turnId} entry={preview} side={side} testID={`arena-preview-${side}`} />
  );
}

/**
 * Where each answer came from, at the end of its heading: a shell in the agent's worktree and a
 * menu with the rest (its path, its services, room for this answer alone).
 */
export function ArenaPaneActions({
  serverId,
  workspaceId,
  agentId,
  side,
  run,
  expanded,
  onToggleExpanded,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  side: ArenaSide;
  run: ArenaRun | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const entries = useMemo(() => (run ? lifecycleServiceEntries(run) : []), [run]);
  const worktree = run?.worktree && run.worktreeActive ? run.worktree : null;
  return (
    <View style={styles.actions}>
      {worktree ? (
        <WorktreeActions
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          side={side}
          worktree={worktree}
          worktreeName={run?.worktreeName}
          entries={entries}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
        />
      ) : (
        <ExpandAction side={side} expanded={expanded} onToggleExpanded={onToggleExpanded} />
      )}
    </View>
  );
}

function ExpandAction({
  side,
  expanded,
  onToggleExpanded,
}: {
  side: ArenaSide;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PaneIconAction
      onPress={onToggleExpanded}
      accessibilityLabel={
        expanded ? t("arena.restoreSplit") : t("arena.expandAgent", { side: side.toUpperCase() })
      }
      testID={`arena-pane-expand-${side}`}
    >
      {expanded ? (
        <ThemedMinimize2 size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      ) : (
        <ThemedMaximize2 size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      )}
    </PaneIconAction>
  );
}

function WorktreeActions({
  serverId,
  workspaceId,
  agentId,
  side,
  worktree,
  worktreeName,
  entries,
  expanded,
  onToggleExpanded,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  side: ArenaSide;
  worktree: string;
  worktreeName?: string;
  entries: ReturnType<typeof lifecycleServiceEntries>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation();
  const sideLabel = side.toUpperCase();
  const { displayPath, openTerminal, canOpenTerminal, copyPath } = useArenaWorktreeActions({
    serverId,
    workspaceId,
    agentId,
    side,
    worktree,
    worktreeName,
  });
  const expandIcon = useMemo(
    () =>
      expanded ? (
        <ThemedMinimize2 size={16} uniProps={mutedColorMapping} />
      ) : (
        <ThemedMaximize2 size={16} uniProps={mutedColorMapping} />
      ),
    [expanded],
  );
  return (
    <>
      {canOpenTerminal ? (
        <PaneIconAction
          onPress={openTerminal}
          accessibilityLabel={t("arena.openTerminalIn", { side: sideLabel })}
          testID={`arena-pane-terminal-${side}`}
        >
          <ThemedSquareTerminal size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </PaneIconAction>
      ) : null}
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityLabel={t("arena.agentWorktree", { side: sideLabel })}
          accessibilityRole="button"
          style={paneIconMenuTriggerStyle}
          testID={`arena-open-worktree-${side}`}
        >
          <ThemedEllipsis size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          width={300}
          sheetTitle={t("arena.agentWorktree", { side: sideLabel })}
          testID={`arena-open-worktree-${side}-content`}
        >
          <DropdownMenuLabel>
            {t("arena.agentWorktreeTitle", { side: sideLabel })}
          </DropdownMenuLabel>
          <WorktreePathLabel side={side} path={displayPath} />
          <DropdownMenuSeparator />
          <OpenTerminalMenuItem disabled={!canOpenTerminal} side={side} onSelect={openTerminal} />
          <CopyPathMenuItem side={side} onSelect={copyPath} />
          <DropdownMenuItem
            leading={expandIcon}
            onSelect={onToggleExpanded}
            testID={`arena-pane-expand-${side}`}
          >
            {expanded ? t("arena.restoreSplit") : t("arena.expandAgent", { side: sideLabel })}
          </DropdownMenuItem>
          {entries.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {t("arena.servicesWorktree", { agent: agentLabel(side) })}
              </DropdownMenuLabel>
              {entries.map((entry) => (
                <ServiceMenuItem key={entry.key} entry={entry} side={side} />
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
}));
