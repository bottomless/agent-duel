import { mkdir, readdir, rename, rm } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

/**
 * Where discarded trees wait to be deleted, relative to the directory they came from.
 *
 * A sibling, so the move is a rename inside one filesystem rather than a copy across two.
 */
export const TRASH_DIRNAME = ".trash"

export function trashFor(target: string) {
  return path.join(path.dirname(target), TRASH_DIRNAME)
}

/**
 * Take a directory out of the caller's way without waiting for it to be deleted.
 *
 * A contestant worktree is upwards of a hundred thousand files, and unlinking one is long
 * enough to be felt by whoever is waiting on it. A rename costs a syscall regardless of what
 * is inside, so the path is free immediately and the bytes can go later. Returns where the
 * tree went, or undefined if it could not be moved — Windows refuses while any handle into
 * the tree is open, and callers have to fall back to deleting in place.
 *
 * A tree with a process still running inside it moves fine on POSIX: the process keeps its
 * working directory by inode and never learns the path changed.
 *
 * `trash` defaults to a sibling of the target. A caller clearing a tree from inside a
 * worktree passes the worktree root's trash instead, so the grave does not show up as an
 * untracked directory in the checkout it was taken out of.
 */
export async function discardTree(target: string, trash = trashFor(target)): Promise<string | undefined> {
  const grave = path.join(trash, `${path.basename(target)}-${randomUUID()}`)
  try {
    await mkdir(trash, { recursive: true })
    await rename(target, grave)
    return grave
  } catch {
    return undefined
  }
}

/**
 * Finish deletions an earlier process did not, under one trash directory.
 *
 * Everything here is already detached from git and from any live path, so there is nothing
 * to identify or spare. Best effort per entry: one tree that cannot be removed must not stop
 * the rest. Returns how many were cleared.
 */
export async function sweepTrash(trash: string): Promise<number> {
  const entries = await readdir(trash).catch(() => [] as string[])
  let cleared = 0
  for (const entry of entries) {
    const removed = await rm(path.join(trash, entry), { recursive: true, force: true }).then(
      () => true,
      () => false,
    )
    if (removed) cleared++
  }
  return cleared
}
