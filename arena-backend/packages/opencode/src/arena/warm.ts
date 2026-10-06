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

/** Collapse wholly ignored directories so a dependency tree is copied as one clone. */
export const IGNORED_PATHS_COMMAND = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--directory",
  "-z",
] as const

export * as ArenaWarm from "./warm"
