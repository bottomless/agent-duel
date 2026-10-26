import os from "os"
import path from "path"
import { realpathSync } from "fs"
import { Global } from "@opencode/util/global"
import { Wildcard } from "@opencode/core/util/wildcard"
import { PermissionV1 } from "@opencode/schema/permission-v1"

/**
 * Rules under this key deny writes into external directories that `external_directory` allows.
 * Only rules with exactly this key count (see `Permission.ask`), so a `*` rule never turns an
 * external write into a second question for a session that has none.
 */
export const EXTERNAL_WRITE = "external_directory_write"

/** What a contestant may not reach or change outside its worktree, and what it reaches inside that. */
export interface Sandbox {
  /** The side's own temp directory. */
  readonly tmp: string
  /** The main checkout, in each spelling of its path. Readable, not writable. */
  readonly readOnly: readonly string[]
  /**
   * The checkout's `.agent-duel` directory, in each spelling of its path. Every Arena worktree lives
   * in it, so this covers the other side's worktree and every earlier turn's as well.
   */
  readonly blocked: readonly string[]
  /** The side's own worktree and host repository, which sit inside `.agent-duel`. */
  readonly own: readonly string[]
}

const tmpRoot = () => path.join(Global.Path.tmp, "arena")
const glob = (directory: string) => path.join(directory, "*")
const GLOB_SUFFIX = path.sep + "*"
const globDirectory = (pattern: string) =>
  pattern.endsWith(GLOB_SUFFIX) ? pattern.slice(0, -GLOB_SUFFIX.length) : pattern

/**
 * `directory` under its own spelling and, when that differs, its real path, so `/private/tmp` cannot
 * route around a rule for `/tmp`. A directory that does not exist yet takes its nearest existing
 * parent's real path.
 */
export function spellings(directory: string): string[] {
  const real = (directory: string): string => {
    try {
      return realpathSync(directory)
    } catch {
      const parent = path.dirname(directory)
      return parent === directory ? directory : path.join(real(parent), path.basename(directory))
    }
  }
  const resolved = real(directory)
  return resolved === directory ? [directory] : [directory, resolved]
}

/** Temp directories every process on the machine shares; both sides of a battle run at once. */
const sharedTmp = () => [...new Set(["/tmp", "/var/tmp", os.tmpdir()].flatMap(spellings))]

/** Where every contestant temp directory lives; see `tmpDirectory`. */
export function tmpParent() {
  return tmpRoot()
}

/**
 * The temp directory of the contestant session `sessionID`. Each side's session gets its own, and
 * neither side reaches the other's or writes to a shared one.
 */
export function tmpDirectory(sessionID: string) {
  return path.join(tmpRoot(), sessionID)
}

/**
 * The inherited rules, then an `external_directory` allow for everything, then the sandbox. Rules
 * are evaluated last match first: the allow overrides the agent's own asks, since a prompt one side
 * gets and the other does not makes the sides unequal; the shared temp directories stay readable
 * but not writable, and every contestant's temp directory is denied outright; the main checkout
 * stays readable but its write deny overrides the allow; `.agent-duel` is denied outright; and the
 * side's own worktree, host repository and temp directory are reopened last, for writes too.
 */
export function contestantPermissions(
  source: PermissionV1.Ruleset | undefined,
  sandbox: Sandbox,
): PermissionV1.Ruleset {
  const deny = (permission: string) => (directory: string) => ({
    permission,
    pattern: glob(directory),
    action: "deny" as const,
  })
  const reopen = (directory: string) => [
    { permission: "external_directory", pattern: glob(directory), action: "allow" as const },
    { permission: EXTERNAL_WRITE, pattern: glob(directory), action: "allow" as const },
  ]
  return [
    ...(source ?? []),
    { permission: "external_directory", pattern: "*", action: "allow" },
    ...sharedTmp().map(deny(EXTERNAL_WRITE)),
    ...spellings(tmpRoot()).map(deny("external_directory")),
    ...sandbox.readOnly.map(deny(EXTERNAL_WRITE)),
    ...sandbox.blocked.map(deny("external_directory")),
    ...sandbox.own.flatMap(reopen),
    // The side's own spelling comes last: it is also what marks the session as a contestant's; see
    // `sandboxTmp`.
    ...spellings(sandbox.tmp).reverse().flatMap(reopen),
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

const deniedDirectories = (ruleset: PermissionV1.Ruleset, permission: string) =>
  ruleset
    .filter((rule) => rule.permission === permission && rule.action === "deny" && rule.pattern.endsWith(GLOB_SUFFIX))
    .map((rule) => globDirectory(rule.pattern))

/**
 * The directories a contestant may not reach, or none outside Arena. A search that starts above
 * one of them leaves it out (see `Tool.Context.blockedDirectories`).
 */
export function blockedDirectories(ruleset: PermissionV1.Ruleset): readonly string[] {
  if (!sandboxTmp(ruleset)) return []
  return deniedDirectories(ruleset, "external_directory")
}

/**
 * The denial a contestant sees for a blocked directory or a write into the read-only checkout or a
 * shared temp directory, or undefined outside Arena and for any other denial. The generic message
 * lists every matching rule, which for a contestant is dozens of absolute paths under the home
 * directory that end up in the transcript and the research upload.
 */
export function denial(input: {
  ruleset: PermissionV1.Ruleset
  permission: string
  pattern: string
  write: boolean
}): string | undefined {
  if (input.permission !== "external_directory") return
  const tmp = sandboxTmp(input.ruleset)
  if (!tmp) return
  const directory = globDirectory(input.pattern)
  const key = input.write ? EXTERNAL_WRITE : "external_directory"
  // The rule that denied the request: the same last match `Permission.evaluate` finds.
  const rule = input.ruleset.findLast((rule) => rule.permission === key && Wildcard.match(input.pattern, rule.pattern))
  if (rule?.action !== "deny") return
  const root = globDirectory(rule.pattern)
  if (input.write) {
    if (sharedTmp().includes(root)) {
      return `Arena contestants cannot change files in ${root}, which both sides use while they run. Use the same name under $TMPDIR (${tmp}) instead.`
    }
    return `Arena contestants can read the main checkout but change files only in their own worktree. ${directory} is in the main checkout.`
  }
  if (spellings(tmpRoot()).includes(root)) {
    return `Arena contestants can use only their own temp directory, $TMPDIR (${tmp}), not ${directory}.`
  }
  return `Arena contestants cannot access any Arena worktree but their own. ${directory} is inside them.`
}

export * as ArenaContestant from "./contestant"
