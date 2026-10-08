import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ArenaContestant, contestantPermissions } from "@/arena/contestant"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"

const skill = path.join(path.sep, "home", "user", ".agents", "skills", "review")
const sandbox = { tmp: ArenaContestant.tmpDirectory("ses_left"), skills: [skill] }

/** The allows upstream grants every agent, which the contestant deny must override. */
const agentAllows = [
  { permission: "external_directory", pattern: "*", action: "ask" as const },
  { permission: "external_directory", pattern: path.join(Global.Path.tmp, "*"), action: "allow" as const },
  { permission: "external_directory", pattern: Truncate.GLOB, action: "allow" as const },
  { permission: "external_directory", pattern: path.join(skill, "*"), action: "allow" as const },
]

describe("Arena contestant permissions", () => {
  test("denies external directories after inherited allow rules", () => {
    const source = [{ permission: "external_directory", pattern: "*", action: "allow" as const }]
    const permissions = contestantPermissions(source, sandbox)

    expect(Permission.evaluate("external_directory", "/repo/*", permissions).action).toBe("deny")
    expect(source).toEqual([{ permission: "external_directory", pattern: "*", action: "allow" }])
  })

  test("preserves unrelated source permissions", () => {
    const permissions = contestantPermissions([{ permission: "edit", pattern: "*", action: "allow" }], sandbox)

    expect(Permission.evaluate("edit", "src/index.ts", permissions).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/repo/*", permissions).action).toBe("deny")
  })

  test("reopens only the side's temp directory and skill directories", () => {
    const ruleset = Permission.merge(agentAllows, contestantPermissions(undefined, sandbox))
    const allowed = (directory: string) =>
      Permission.evaluate("external_directory", path.join(directory, "*"), ruleset).action

    expect(allowed(path.join(skill, "references"))).toBe("allow")
    expect(allowed(sandbox.tmp)).toBe("allow")
    expect(allowed(path.join(sandbox.tmp, "nested"))).toBe("allow")
    expect(allowed(Global.Path.tmp)).toBe("deny")
    expect(allowed(ArenaContestant.tmpDirectory("ses_right"))).toBe("deny")
    expect(allowed(Truncate.DIR)).toBe("deny")
    expect(allowed("/tmp")).toBe("deny")
  })

  test("keeps skill directories read-only", () => {
    const ruleset = contestantPermissions(undefined, sandbox)

    expect(Permission.evaluate(ArenaContestant.EXTERNAL_WRITE, path.join(skill, "*"), ruleset).action).toBe("deny")
    expect(Permission.evaluate(ArenaContestant.EXTERNAL_WRITE, path.join(sandbox.tmp, "*"), ruleset).action).not.toBe(
      "deny",
    )
  })

  test("gives each side its own temp directory", () => {
    const left = contestantPermissions(undefined, sandbox)
    const right = contestantPermissions(undefined, { ...sandbox, tmp: ArenaContestant.tmpDirectory("ses_right") })

    expect(ArenaContestant.sandboxTmp(left)).toBe(sandbox.tmp)
    expect(ArenaContestant.sandboxTmp(right)).toBe(ArenaContestant.tmpDirectory("ses_right"))
    expect(Permission.evaluate("external_directory", path.join(sandbox.tmp, "*"), right).action).toBe("deny")
    expect(ArenaContestant.sandboxTmp(agentAllows)).toBeUndefined()
  })

  test("subagents inherit the sandbox", () => {
    const permission = deriveSubagentSessionPermission({
      parentSessionPermission: contestantPermissions(undefined, sandbox),
      subagent: { permission: [] } as unknown as Parameters<typeof deriveSubagentSessionPermission>[0]["subagent"],
    })

    expect(ArenaContestant.sandboxTmp(permission)).toBe(sandbox.tmp)
    expect(Permission.evaluate("external_directory", "/repo/*", permission).action).toBe("deny")
    expect(Permission.evaluate(ArenaContestant.EXTERNAL_WRITE, path.join(skill, "*"), permission).action).toBe("deny")
  })

  test("explains a denial without listing the rules", () => {
    const ruleset = contestantPermissions(agentAllows, sandbox)
    const outside = ArenaContestant.denial({
      ruleset,
      permission: "external_directory",
      pattern: path.join("/repo", "*"),
      write: false,
    })

    expect(outside).toBe(
      `Arena contestants can access only the worktree, ${sandbox.tmp}, attached files, and skill directories (read-only). /repo is outside them.`,
    )
    expect(
      ArenaContestant.denial({
        ruleset,
        permission: "external_directory",
        pattern: path.join(skill, "*"),
        write: true,
      }),
    ).toBe(`${skill} is in a skill directory, which Arena contestants can read but not change.`)
    expect(
      ArenaContestant.denial({
        ruleset: agentAllows,
        permission: "external_directory",
        pattern: "/repo/*",
        write: false,
      }),
    ).toBeUndefined()
    expect(ArenaContestant.denial({ ruleset, permission: "bash", pattern: "rm", write: false })).toBeUndefined()
  })
})
