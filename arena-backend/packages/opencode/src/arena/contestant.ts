import { PermissionV1 } from "@opencode-ai/core/v1/permission"

const externalDirectoryDeny = {
  permission: "external_directory",
  pattern: "*",
  action: "deny",
} as const

export function contestantPermissions(source?: PermissionV1.Ruleset): PermissionV1.Ruleset {
  return [...(source ?? []), externalDirectoryDeny]
}

export * as ArenaContestant from "./contestant"
