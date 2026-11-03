/**
 * Where a reply's files are read. A slot is renamed for the next turn soon after the vote, so a
 * path into it would reach nothing, or a later contestant's tree. The applied side's files live on
 * in the chat's workspace; the other side's are gone.
 */
export type ArenaReplyFiles =
  | { kind: "worktree"; root: string }
  | { kind: "applied"; worktree: string }
  | { kind: "removed"; worktree: string };

export function arenaReplyFiles(
  run: { worktree: string; worktreeActive: boolean },
  applied: boolean,
): ArenaReplyFiles {
  if (run.worktreeActive) return { kind: "worktree", root: run.worktree };
  return applied
    ? { kind: "applied", worktree: run.worktree }
    : { kind: "removed", worktree: run.worktree };
}

/** The engine retargets the winner's transcript the same way (`canonical-path.ts`). */
export function retargetWorktreePaths(text: string, worktree: string, root: string): string {
  if (!worktree) return text;
  const escaped = worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=/|$)`, "gm"), root);
}
