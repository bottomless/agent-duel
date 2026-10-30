import path from "path"
import { LOCAL_STATE_DIRNAME } from "@/worktree/layout"
import type { Worktree } from "@/worktree"

/**
 * Parse Git's NUL-delimited ignored-path listing into safe copy roots.
 *
 * Git occasionally lists a collapsed directory and a path inside it in the same run — a
 * directory ignored by one rule whose child matches another. The child is dropped: the
 * directory is copied as one tree, and copying the child again would land inside it twice.
 */
export function parseIgnoredPaths(output: string): readonly string[] {
  const roots = Array.from(
    new Set(
      output
        .split("\0")
        .map((entry) => entry.trim().replace(/\/+$/, ""))
        .filter((entry) => entry.length > 0)
        .filter((entry) => entry !== ".git" && !entry.startsWith(".git/"))
        .filter((entry) => entry !== LOCAL_STATE_DIRNAME && !entry.startsWith(`${LOCAL_STATE_DIRNAME}/`)),
    ),
  )
  return roots.filter((entry) => !roots.some((other) => other !== entry && entry.startsWith(`${other}/`)))
}

/** Copy all ignored setup output from one prepared contestant into the other. */
export function warmSeed(warmDirectory: string, ignored: readonly string[]): readonly Worktree.SeedEntry[] {
  return ignored.map((entry) => ({ source: path.join(warmDirectory, entry), target: entry }))
}

/**
 * Collapse wholly ignored directories so a dependency tree is copied as one clone.
 *
 * An empty folder counts as untracked content and stops its parent from collapsing, but no
 * worktree holds one, since git does not record it. Without `--no-empty-directory` a folder of
 * `.DS_Store` files beside an empty folder is several roots in the checkout and one root in every
 * contestant, and the contestant's check that it holds the checkout's roots fails every battle.
 * The flag also hides an ignored folder that holds no file; `withEmptyIgnoredFolders` adds it back.
 */
export const IGNORED_PATHS_COMMAND = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--directory",
  "--no-empty-directory",
  "-z",
] as const

/** The same listing with empty folders, for the ignored folders that hold no file. */
export const ALL_IGNORED_PATHS_COMMAND = IGNORED_PATHS_COMMAND.filter((arg) => arg !== "--no-empty-directory")

/**
 * The roots of `IGNORED_PATHS_COMMAND` and every path of `ALL_IGNORED_PATHS_COMMAND` none of them
 * holds, which is an ignored folder with no file in it, such as an empty `logs/` a program expects.
 */
export function withEmptyIgnoredFolders(roots: readonly string[], all: readonly string[]): string[] {
  const held = (entry: string) => roots.some((root) => entry === root || entry.startsWith(`${root}/`))
  return [...roots, ...all.filter((entry) => !held(entry))]
}

export * as ArenaWarm from "./warm"
