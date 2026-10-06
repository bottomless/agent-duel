import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface WorkspaceCommandCenterLabels {
  section: string;
  newTerminal: string;
  newBrowser: string;
}

export interface WorkspaceCommandCenterIcons {
  newTerminal?: CommandCenterIcon;
  newBrowser?: CommandCenterIcon;
  git?(action: GitAction): CommandCenterIcon | undefined;
}

export interface WorkspaceCommandCenterShortcuts {
  newTerminal?: ShortcutKey[][];
  archiveWorkspace?: ShortcutKey[][];
}

export interface WorkspaceCommandCenterSource {
  gitActions: GitActions;
  labels: WorkspaceCommandCenterLabels;
  icons: WorkspaceCommandCenterIcons;
  shortcuts: WorkspaceCommandCenterShortcuts;
  capabilities: {
    canOpenBrowserTabs: boolean;
  };
  dispatch(action: KeyboardActionDefinition): void;
  runGitAction(action: GitAction): void;
}

function buildGitContribution(
  source: WorkspaceCommandCenterSource,
  action: GitAction,
  rank: number,
  visibility: "always" | "query",
): CommandCenterContribution {
  return {
    id: `git:${action.id}`,
    group: "workspace",
    groupRank: -1,
    rank,
    keywords: [action.id, "git"],
    visibility,
    run: () => source.runGitAction(action),
    presentation: {
      kind: "action",
      title: action.label,
      sectionTitle: source.labels.section,
      icon: source.icons.git?.(action),
      shortcutKeys:
        action.id === "archive-workspace" ? source.shortcuts.archiveWorkspace : undefined,
    },
  };
}

function buildWorkspaceAction(input: {
  source: WorkspaceCommandCenterSource;
  id: string;
  rank: number;
  title: string;
  keywords: readonly string[];
  icon?: CommandCenterIcon;
  shortcutKeys?: ShortcutKey[][];
  action: KeyboardActionDefinition;
  visibility: "always" | "query";
}): CommandCenterContribution {
  return {
    id: input.id,
    group: "workspace",
    groupRank: -1,
    rank: input.rank,
    keywords: input.keywords,
    visibility: input.visibility,
    run: () => input.source.dispatch(input.action),
    presentation: {
      kind: "action",
      title: input.title,
      sectionTitle: input.source.labels.section,
      icon: input.icon,
      shortcutKeys: input.shortcutKeys,
    },
  };
}

export function buildWorkspaceCommandCenterContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  const primary = source.gitActions.primary;
  if (primary) contributions.push(buildGitContribution(source, primary, 0, "always"));
  contributions.push(
    buildWorkspaceAction({
      source,
      id: "tab:new-terminal",
      rank: 1,
      title: source.labels.newTerminal,
      keywords: ["terminal", "shell", "console"],
      icon: source.icons.newTerminal,
      shortcutKeys: source.shortcuts.newTerminal,
      action: { id: "workspace.terminal.new", scope: "workspace" },
      visibility: "query",
    }),
  );
  if (source.capabilities.canOpenBrowserTabs) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "tab:new-browser",
        rank: 2,
        title: source.labels.newBrowser,
        keywords: ["browser", "web", "preview"],
        icon: source.icons.newBrowser,
        action: { id: "workspace.browser.new", scope: "workspace" },
        visibility: "query",
      }),
    );
  }
  // Both lists: with a primary action the rest hang off its caret, and with none they are in the
  // overflow menu instead. The command center offers the same actions either way.
  const listed = [...source.gitActions.secondary, ...source.gitActions.menu];
  for (const [index, action] of listed.entries()) {
    if (action.id === primary?.id) continue;
    contributions.push(buildGitContribution(source, action, 10 + index, "query"));
  }
  return contributions;
}
