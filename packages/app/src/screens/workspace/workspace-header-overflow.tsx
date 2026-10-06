import { useEffect, useState } from "react";
import { Copy, Ellipsis, Settings } from "lucide-react-native";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ArenaEnvironmentDetails, arenaEnvironmentLabel } from "@/arena/readiness-strip";
import { WorkspaceActionsMenuItems } from "@/git/workspace-actions";
import {
  WorkspaceOpenInEditorMenuItems,
  WorkspaceOpenInEditorSubTrigger,
} from "./workspace-open-in-editor-button";
import { WorkspaceScriptsMenuItems } from "./workspace-scripts-button";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { Theme } from "@/styles/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedCopy = withUnistyles(Copy);
const ThemedSettings = withUnistyles(Settings);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const copyIcon = <ThemedCopy size={16} uniProps={mutedColorMapping} />;
const settingsIcon = <ThemedSettings size={16} uniProps={mutedColorMapping} />;
const hitSlop = { top: 8, bottom: 8 };

interface WorkspaceHeaderOverflowProps {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  activeFile: WorkspaceFileLocation | null;
  snapshot: ArenaSnapshot | undefined;
  agentId: string | null;
  isWorktree: boolean;
  collapsed: boolean;
  isFocused: boolean;
  branchName: string | null;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds: string[];
  onScriptTerminalStarted: (id: string) => void;
  onViewTerminal: (id: string) => void;
  onOpenUrlInBrowserTab: (url: string) => void;
  showWorkspaceSetup: boolean;
  onCopyPath: () => void;
  onCopyBranch: () => void;
  onOpenSetup: () => void;
  showChanges: boolean;
  onOpenChanges: () => void;
}

function triggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  return [styles.trigger, (hovered || pressed || open) && styles.active];
}

export function WorkspaceHeaderOverflow(props: WorkspaceHeaderOverflowProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [props.collapsed, props.isFocused]);
  const environmentLabel = props.snapshot
    ? arenaEnvironmentLabel(props.snapshot, props.isWorktree)
    : undefined;
  const pages: MenuPageDefinition[] = [];
  if (props.collapsed) {
    if (props.snapshot && props.agentId) {
      pages.push({
        id: "environment",
        title: "Environment",
        content: (
          <ArenaEnvironmentDetails
            serverId={props.serverId}
            workspaceId={props.workspaceId}
            agentId={props.agentId}
            snapshot={props.snapshot}
          />
        ),
      });
    }
    if (props.cwd) {
      pages.push({
        id: "editor",
        title: t("workspace.git.openInEditor.chooseEditor"),
        content: (
          <WorkspaceOpenInEditorMenuItems
            serverId={props.serverId}
            cwd={props.cwd}
            activeFile={props.activeFile}
          />
        ),
      });
    }
    if (props.scripts.length > 0) {
      pages.push({
        id: "scripts",
        title: t("workspace.scripts.title"),
        content: (
          <WorkspaceScriptsMenuItems
            serverId={props.serverId}
            workspaceId={props.workspaceId}
            scripts={props.scripts}
            liveTerminalIds={props.liveTerminalIds}
            onScriptTerminalStarted={props.onScriptTerminalStarted}
            onViewTerminal={props.onViewTerminal}
            onOpenUrlInBrowserTab={props.onOpenUrlInBrowserTab}
          />
        ),
      });
    }
  }
  return (
    <DropdownMenu open={open && props.isFocused} onOpenChange={setOpen} compactMode="sheet">
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            testID="workspace-header-menu-trigger"
            style={triggerStyle}
            hitSlop={isCompact ? hitSlop : undefined}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.header.actions.workspaceActions")}
          >
            <ThemedEllipsis size={16} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("workspace.header.actions.workspaceActions")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        width={360}
        pages={pages}
        testID="workspace-header-menu"
        sheetTitle={t("workspace.header.actions.workspaceActions")}
      >
        {pages.map((page) =>
          page.id === "editor" && props.cwd ? (
            <WorkspaceOpenInEditorSubTrigger
              key={page.id}
              id={page.id}
              testID="workspace-header-overflow-editor"
              serverId={props.serverId}
              cwd={props.cwd}
              activeFile={props.activeFile}
            />
          ) : (
            <DropdownMenuSubTrigger
              key={page.id}
              id={page.id}
              testID={`workspace-header-overflow-${page.id}`}
              value={page.id === "environment" ? environmentLabel : undefined}
            >
              {page.title}
            </DropdownMenuSubTrigger>
          ),
        )}
        {props.cwd ? (
          <>
            {props.collapsed ? <DropdownMenuSeparator /> : null}
            <WorkspaceActionsMenuItems
              serverId={props.serverId}
              cwd={props.cwd}
              onlyWhenNoPrimary={!props.collapsed}
            />
          </>
        ) : null}
        {props.collapsed && props.showChanges ? (
          <DropdownMenuItem testID="workspace-header-menu-changes" onSelect={props.onOpenChanges}>
            {t("workspace.tabs.actions.openChanges")}
          </DropdownMenuItem>
        ) : null}
        {props.collapsed ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          testID="workspace-header-copy-path"
          leading={copyIcon}
          disabled={!props.cwd}
          onSelect={props.onCopyPath}
        >
          {t("workspace.header.actions.copyPath")}
        </DropdownMenuItem>
        {props.branchName ? (
          <DropdownMenuItem
            testID="workspace-header-copy-branch-name"
            leading={copyIcon}
            onSelect={props.onCopyBranch}
          >
            {t("workspace.header.actions.copyBranchName")}
          </DropdownMenuItem>
        ) : null}
        {props.showWorkspaceSetup ? (
          <DropdownMenuItem
            testID="workspace-header-show-setup"
            leading={settingsIcon}
            onSelect={props.onOpenSetup}
          >
            {t("workspace.header.actions.showSetup")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  trigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  active: { backgroundColor: theme.colors.surface2 },
}));
