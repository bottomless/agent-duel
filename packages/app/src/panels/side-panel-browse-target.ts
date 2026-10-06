import { useCallback, useMemo } from "react";
import {
  arenaExplorerOptionId,
  arenaExplorerOptionLabel,
  parseArenaExplorerOptionId,
} from "@/arena/explorer-target";
import { useArenaExplorerTarget } from "@/arena/use-explorer-target";
import type { GitDiffPaneBranchTargets } from "@/git/diff-pane";

const CONTESTANT_OPTION_DESCRIPTION = "Battle worktree";

/** What the Changes and Files tabs browse, and how they were told to. */
export interface SidePanelBrowseTarget {
  workspaceId: string | null | undefined;
  workspaceRoot: string;
  onOpenFile: ((filePath: string) => void) | undefined;
  readOnly: boolean;
}

/**
 * The Changes and Files tabs browse the checkout until someone picks a contestant
 * worktree from the branch dropdown. Those live on a detached HEAD, so they
 * cannot be a branch entry: they ride along as pinned options and retarget the
 * tab instead.
 *
 * A contestant worktree is not the workspace, so it drops the workspace identity
 * with it: pane caches key on the path, files cannot open into a workspace tab
 * that would resolve them against the checkout, and nothing writes to a directory
 * a running battle owns.
 */
export function useSidePanelBrowseTarget({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
}: {
  serverId: string;
  workspaceId: string | null | undefined;
  workspaceRoot: string;
  onOpenFile: ((filePath: string) => void) | undefined;
}): {
  branchTargets: GitDiffPaneBranchTargets | undefined;
  pane: SidePanelBrowseTarget;
} {
  const { targets, selected, select } = useArenaExplorerTarget({ serverId, workspaceId });
  const handleSelect = useCallback(
    (id: string | null) => select(id === null ? null : parseArenaExplorerOptionId(id)),
    [select],
  );
  const branchTargets = useMemo<GitDiffPaneBranchTargets | undefined>(
    () =>
      targets.length === 0
        ? undefined
        : {
            options: targets.map((target) => ({
              id: arenaExplorerOptionId(target.side),
              label: arenaExplorerOptionLabel(target.side),
              description: CONTESTANT_OPTION_DESCRIPTION,
            })),
            selectedId: selected ? arenaExplorerOptionId(selected.side) : null,
            onSelect: handleSelect,
            directory: workspaceRoot,
          },
    [handleSelect, selected, targets, workspaceRoot],
  );
  const pane = useMemo<SidePanelBrowseTarget>(
    () =>
      selected
        ? {
            workspaceId: null,
            workspaceRoot: selected.worktree,
            onOpenFile: undefined,
            readOnly: true,
          }
        : { workspaceId, workspaceRoot, onOpenFile, readOnly: false },
    [onOpenFile, selected, workspaceId, workspaceRoot],
  );
  return { branchTargets, pane };
}
