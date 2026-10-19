import path from "path"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

/**
 * Rules under this key deny writes into external directories that `external_directory` allows.
 * Only rules with exactly this key count (see `Permission.ask`), so a `*` rule never turns an
 * external write into a second question for a session that has none.
 */
export const EXTERNAL_WRITE = "external_directory_write"

/** What a contestant may not reach outside its worktree, and what it reaches inside that. */
export interface Sandbox {
  /** The side's own temp directory. */
  readonly tmp: string
  /**
   * The main checkout, in each spelling of its path. Every Arena worktree lives inside it, so this
   * covers the other side's worktree and every earlier turn's as well.
   */
  readonly blocked: readonly string[]
  /** The side's own worktree and host repository, which sit inside the main checkout. */
  readonly own: readonly string[]
}

const tmpRoot = () => path.join(Global.Path.tmp, "arena")
const glob = (directory: string) => path.join(directory, "*")
const GLOB_SUFFIX = path.sep + "*"
const globDirectory = (pattern: string) =>
  pattern.endsWith(GLOB_SUFFIX) ? pattern.slice(0, -GLOB_SUFFIX.length) : pattern

/** Where every contestant temp directory lives; see `tmpDirectory`. */
export function tmpParent() {
  return tmpRoot()
}

/**
 * The temp directory of the contestant session `sessionID`. Each side's session gets its own, so
 * the two sides never write into each other's.
 */
export function tmpDirectory(sessionID: string) {
  return path.join(tmpRoot(), sessionID)
}

/**
 * The inherited rules, then an `external_directory` allow for everything, then the sandbox. Rules
 * are evaluated last match first: the allow overrides the agent's own asks, since a prompt one side
 * gets and the other does not makes the sides unequal; the main checkout's deny overrides the allow;
 * and the side's own worktree and host repository, inside the checkout, are reopened last.
 */
export function contestantPermissions(
  source: PermissionV1.Ruleset | undefined,
  sandbox: Sandbox,
): PermissionV1.Ruleset {
  return [
    ...(source ?? []),
    { permission: "external_directory", pattern: "*", action: "allow" },
    // Also what marks the session as a contestant's; see `sandboxTmp`.
    { permission: "external_directory", pattern: glob(sandbox.tmp), action: "allow" },
    ...sandbox.blocked.map((directory) => ({
      permission: "external_directory",
      pattern: glob(directory),
      action: "deny" as const,
    })),
    ...sandbox.own.map((directory) => ({
      permission: "external_directory",
      pattern: glob(directory),
      action: "allow" as const,
    })),
  ]
}

/**
 * The contestant temp directory a ruleset grants, or undefined outside Arena. Subagents inherit
 * their parent's `external_directory` rules, so they share the side's directory.
 */
export function sandboxTmp(ruleset: PermissionV1.Ruleset): string | undefined {
  const prefix = tmpRoot() + path.sep
  const rule = ruleset.findLast(
    (rule) =>
      rule.permission === "external_directory" &&
      rule.action === "allow" &&
      rule.pattern.startsWith(prefix) &&
      rule.pattern.endsWith(GLOB_SUFFIX),
  )
  return rule ? globDirectory(rule.pattern) : undefined
}

/**
 * The directories a contestant may not reach, or none outside Arena. A search that starts above
 * one of them leaves it out (see `Tool.Context.blockedDirectories`).
 */
export function blockedDirectories(ruleset: PermissionV1.Ruleset): readonly string[] {
  if (!sandboxTmp(ruleset)) return []
  return ruleset
    .filter(
      (rule) =>
        rule.permission === "external_directory" && rule.action === "deny" && rule.pattern.endsWith(GLOB_SUFFIX),
    )
    .map((rule) => globDirectory(rule.pattern))
}

/**
 * The denial a contestant sees for a blocked directory, or undefined outside Arena and for any other
 * denial. The generic message lists every matching rule, which for a contestant is dozens of absolute
 * paths under the home directory that end up in the transcript and the research upload.
 */
export function denial(input: {
  ruleset: PermissionV1.Ruleset
  permission: string
  pattern: string
  write: boolean
}): string | undefined {
  if (input.permission !== "external_directory") return
  const directory = globDirectory(input.pattern)
  const blocked = blockedDirectories(input.ruleset).some(
    (root) => directory === root || directory.startsWith(root + path.sep),
  )
  if (!blocked) return
  return `Arena contestants cannot access the main checkout or any Arena worktree but their own. ${directory} is inside them.`
}

export * as ArenaContestant from "./contestant"
