import path from "node:path"
import { realpathSync } from "node:fs"
import { Permission } from "@opencode/schema/permission"
import { Global } from "@opencode/util/global"

const GLOB_SUFFIX = path.sep + "*"

export interface Sandbox {
  readonly tmp: string
  readonly readOnly: readonly string[]
  readonly blocked: readonly string[]
  readonly own: readonly string[]
}

const tmpRoot = () => path.join(Global.Path.tmp, "arena")
const glob = (directory: string) => path.join(directory, "*")
const globDirectory = (pattern: string) =>
  pattern.endsWith(GLOB_SUFFIX) ? pattern.slice(0, -GLOB_SUFFIX.length) : pattern

function spellings(directory: string) {
  const real = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      const parent = path.dirname(value)
      return parent === value ? value : path.join(real(parent), path.basename(value))
    }
  }
  const resolved = real(directory)
  return resolved === directory ? [directory] : [directory, resolved]
}

const contestantTmp = (sessionID: string) => path.join(tmpRoot(), sessionID)
const sharedTmp = () => [...new Set(["/tmp", "/var/tmp", Global.Path.tmp].flatMap(spellings))]

function contestantPermissions(source: Permission.Ruleset | undefined, sandbox: Sandbox): Permission.Ruleset {
  const deny = (action: string) => (directory: string) => ({
    action,
    resource: glob(directory),
    effect: "deny" as const,
  })
  const reopen = (directory: string) => [
    { action: "external_directory", resource: glob(directory), effect: "allow" as const },
    { action: "read", resource: glob(directory), effect: "allow" as const },
    { action: "edit", resource: glob(directory), effect: "allow" as const },
  ]
  return [
    ...(source ?? []),
    { action: "external_directory", resource: "*", effect: "allow" },
    ...sharedTmp().map(deny("edit")),
    ...spellings(tmpRoot()).map(deny("external_directory")),
    ...sandbox.readOnly.flatMap((directory) => [deny("edit")(directory), deny("external_directory")(directory)]),
    ...sandbox.blocked.map(deny("external_directory")),
    ...sandbox.own.flatMap(reopen),
    ...spellings(sandbox.tmp).reverse().flatMap(reopen),
  ]
}

export interface ArenaSandbox extends Sandbox {
  readonly sessionID: string
}

export function sandboxForSession(sessionID: string, worktree: string, mainDirectory: string): ArenaSandbox {
  const tmp = contestantTmp(sessionID)
  return {
    sessionID,
    tmp,
    readOnly: spellings(mainDirectory),
    blocked: spellings(path.join(mainDirectory, ".agent-duel")),
    own: spellings(worktree),
  }
}

export function permissionRules(source: Parameters<typeof contestantPermissions>[0], sandbox: ArenaSandbox) {
  return contestantPermissions(source, sandbox)
}

export function previewEnvironment(sessionID: string, preview: Readonly<Record<string, string | undefined>> = {}) {
  const tmp = contestantTmp(sessionID)
  return {
    ...preview,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  }
}

export function toolEnvironment(sessionID: string, preview: Readonly<Record<string, string | undefined>> = {}) {
  return previewEnvironment(sessionID, preview)
}

export * as ArenaEngineSandbox from "./sandbox.js"
