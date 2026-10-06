import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Copy, FolderOpen, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { toErrorMessage } from "@/utils/error-messages";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { contestantWorktreeDisplayPath } from "./environment";
import { paneIconMenuTriggerStyle } from "./pane-icon-action";
import { buildArenaSeatTerminalTarget } from "./seat-terminals";
import { WrappedPath } from "./wrapped-path";

const ThemedFolderOpen = withUnistyles(FolderOpen);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedCopy = withUnistyles(Copy);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function OpenTerminalItem({
  disabled,
  side,
  onSelect,
}: {
  disabled: boolean;
  side: ArenaSide;
  onSelect: () => void;
}) {
  const leading = useMemo(
    () => <ThemedSquareTerminal size={16} uniProps={mutedColorMapping} />,
    [],
  );
  return (
    <DropdownMenuItem
      disabled={disabled}
      leading={leading}
      onSelect={onSelect}
      testID={`arena-open-terminal-${side}`}
    >
      Open terminal here
    </DropdownMenuItem>
  );
}

/**
 * The one place a contestant's location lives: a directory button whose menu names the
 * worktree, shows where it is, and offers the two things a voter does with it.
 */
export function ArenaWorktreeMenuButton({
  serverId,
  workspaceId,
  agentId,
  side,
  worktree,
  worktreeName,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  side: ArenaSide;
  worktree: string;
  worktreeName?: string;
}) {
  const toast = useToast();
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const sideLabel = side.toUpperCase();
  const persistenceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const displayPath = contestantWorktreeDisplayPath(worktree, worktreeName);

  // Every open is a new shell, the way the workspace's own "New terminal" is. The tab that
  // carries it is not this turn's worktree: the panel moves the shell from one turn's worktree
  // to the next, so the session outlives the worktree it started in.
  const openTerminal = useCallback(() => {
    if (!persistenceKey) return;
    openWorkspaceTabFocused(persistenceKey, buildArenaSeatTerminalTarget({ agentId, side }));
  }, [agentId, openWorkspaceTabFocused, persistenceKey, side]);

  const copyPath = useCallback(() => {
    void copyToClipboard(worktree)
      .then(() => toast.copied(`Agent ${sideLabel} worktree path copied`))
      .catch((error) => toast.error(toErrorMessage(error)));
  }, [sideLabel, toast, worktree]);
  const copyIcon = useMemo(() => <ThemedCopy size={16} uniProps={mutedColorMapping} />, []);

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityLabel={`Agent ${sideLabel} worktree`}
        accessibilityRole="button"
        style={paneIconMenuTriggerStyle}
        testID={`arena-open-worktree-${side}`}
      >
        <ThemedFolderOpen size={ICON_SIZE.xs} uniProps={foregroundColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={280}
        sheetTitle={`Agent ${sideLabel} worktree`}
        testID={`arena-open-worktree-${side}-content`}
      >
        <DropdownMenuLabel>{`Agent ${sideLabel}'s worktree`}</DropdownMenuLabel>
        <View style={styles.pathContainer}>
          <WrappedPath
            path={displayPath}
            style={styles.path}
            testID={`arena-worktree-path-${side}`}
          />
        </View>
        <DropdownMenuSeparator />
        <OpenTerminalItem disabled={!persistenceKey} side={side} onSelect={openTerminal} />
        <DropdownMenuItem
          leading={copyIcon}
          onSelect={copyPath}
          testID={`arena-copy-worktree-${side}`}
        >
          Copy path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  pathContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  path: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
}));
