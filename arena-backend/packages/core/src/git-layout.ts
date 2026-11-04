import path from "path"
import { lstat, readFile } from "fs/promises"

/**
 * What a checkout's layout follows from: a `.git` directory is its own repository and keeps its
 * identity, while a `.git` file names the administration directory of the worktree it links. Where
 * the checkout, its git directory and its common directory are cannot change while this key stays
 * the same, so answers to those questions can be kept by it. Undefined when `.git` cannot be read,
 * which keeps nothing.
 */
export async function layoutKey(dotgit: string) {
  const stats = await lstat(dotgit).catch(() => undefined)
  if (stats?.isDirectory()) return `${dotgit}\0directory\0${stats.dev}:${stats.ino}`
  if (!stats?.isFile()) return undefined
  const link = await readFile(dotgit, "utf8").catch(() => undefined)
  return link === undefined ? undefined : `${dotgit}\0file\0${link}`
}

/** The `layoutKey` of the nearest `.git` at or above a directory, as git finds it. */
export async function checkoutLayoutKey(directory: string) {
  let current = path.resolve(directory)
  for (;;) {
    const dotgit = path.join(current, ".git")
    if (await lstat(dotgit).then(Boolean, () => false)) return layoutKey(dotgit)
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export * as GitLayout from "./git-layout"
