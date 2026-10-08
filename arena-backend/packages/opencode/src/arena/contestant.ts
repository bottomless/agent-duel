import path from "path"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

/**
 * Rules under this key deny writes into external directories that `external_directory` allows.
 * Only rules with exactly this key count (see `Permission.ask`), so a `*` rule never turns an
 * external write into a second question for a session that has none.
 */
export const EXTERNAL_WRITE = "external_directory_write"

const externalDirectoryDeny = {
  permission: "external_directory",
  pattern: "*",
  action: "deny",
} as const

/** What a contestant may reach outside its worktree, besides the uploads its prompts name. */
export interface Sandbox {
  /** The side's own temp directory, readable and writable. */
  readonly tmp: string
  /** Skill directories, readable only. */
  readonly skills: readonly string[]
}

const tmpRoot = () => path.join(Global.Path.tmp, "arena")
const glob = (directory: string) => path.join(directory, "*")
const GLOB_SUFFIX = path.sep + "*"
const globDirectory = (pattern: string) =>
  pattern.endsWith(GLOB_SUFFIX) ? pattern.slice(0, -GLOB_SUFFIX.length) : pattern

/**
 * The temp directory of the contestant session `sessionID`. Each side's session gets its own, so
 * the two sides never see each other's files; the shared `Global.Path.tmp` stays denied.
 */
export function tmpDirectory(sessionID: string) {
  return path.join(tmpRoot(), sessionID)
}

/**
 * The inherited rules, then a hard `external_directory` deny, then the sandbox. Rules are
 * evaluated last match first, so the deny overrides the agent's own allows (its skill directories,
 * `Global.Path.tmp`, the truncation directory) and only the sandbox rules after it reopen paths.
 */
export function contestantPermissions(
  source: PermissionV1.Ruleset | undefined,
  sandbox: Sandbox,
): PermissionV1.Ruleset {
  return [
    ...(source ?? []),
    externalDirectoryDeny,
    ...sandbox.skills.flatMap((directory) => [
      { permission: "external_directory", pattern: glob(directory), action: "allow" as const },
      { permission: EXTERNAL_WRITE, pattern: glob(directory), action: "deny" as const },
    ]),
    { permission: "external_directory", pattern: glob(sandbox.tmp), action: "allow" },
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
 * The denial a contestant sees for a path outside its sandbox, or undefined outside Arena. The
 * generic message lists every matching rule, which for a contestant is dozens of absolute paths
 * under the home directory that end up in the transcript and the research upload.
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
  if (input.write) return `${directory} is in a skill directory, which Arena contestants can read but not change.`
  return `Arena contestants can access only the worktree, ${tmp}, attached files, and skill directories (read-only). ${directory} is outside them.`
}

export * as ArenaContestant from "./contestant"
