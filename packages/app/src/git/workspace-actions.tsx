import { GitActionMenuItems, GitActionsSplitButton } from "@/git/actions-split-button";
import { getGitActionMenuActions } from "@/git/actions-menu";
import { useGitActions } from "@/git/use-actions";
import { GIT_ACTION_ICONS } from "@/git/action-icons";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
  hideLabels?: boolean;
  hideOverflow?: boolean;
}

export function WorkspaceActions({
  serverId,
  cwd,
  hideLabels,
  hideOverflow,
}: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return (
    <GitActionsSplitButton
      gitActions={gitActions}
      hideLabels={hideLabels}
      hideOverflow={hideOverflow}
    />
  );
}

interface WorkspaceActionsMenuItemsProps {
  serverId: string;
  cwd: string;
  onlyWhenNoPrimary?: boolean;
}

export function WorkspaceActionsMenuItems({
  serverId,
  cwd,
  onlyWhenNoPrimary = false,
}: WorkspaceActionsMenuItemsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  if (onlyWhenNoPrimary && gitActions.primary) {
    return null;
  }

  return <GitActionMenuItems actions={getGitActionMenuActions(gitActions)} />;
}
