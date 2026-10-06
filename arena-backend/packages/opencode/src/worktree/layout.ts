/**
 * Where an isolated worktree and the repository that owns it sit on disk.
 *
 * Its own module because both the worktree service that builds this layout and the Arena
 * code that has to keep the checkout blind to it need the same answer, and neither should
 * have to import the other's service to get it.
 */

/** The directory a checkout keeps Agent Duel's state in. Excluded from the checkout. */
export const LOCAL_STATE_DIRNAME = ".agent-duel";

/**
 * Isolated worktrees live inside the checkout they were built from, not in the daemon's
 * data directory. Deleting the checkout is then the whole cleanup: nothing a battle built
 * outlives the repository it ran against.
 */
export function localStatePath(checkout: string) {
  return `${checkout}/${LOCAL_STATE_DIRNAME}`;
}

export function isolatedRoot(checkout: string) {
  return `${localStatePath(checkout)}/worktrees`;
}

/**
 * The bare repository that owns an isolated worktree, beside the tree it serves.
 *
 * One definition, because both the code that creates the repository and the code that
 * later removes the worktree have to arrive at the same path from the directory alone.
 */
export function hostRepoPath(directory: string) {
  return `${directory}.git`;
}

/**
 * Ref namespaces that are Arena's own bookkeeping in the checkout: battle results, the side
 * branches of older turns, and a host's start-of-turn ref snapshot.
 *
 * None of them reach a contestant host. The battle refs keep every earlier turn's results,
 * the losing sides' work included. The host's copied objects still hold them; without the refs
 * they only stay out of the history a contestant browses.
 */
export const PRIVATE_REF_PREFIXES = [
  "refs/battles/",
  "refs/heads/agent-duel/",
  "refs/agent-duel/",
] as const;
