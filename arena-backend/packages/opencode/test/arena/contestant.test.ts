import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ArenaContestant, contestantPermissions } from "@/arena/contestant"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Permission } from "@/permission"
import { excludedBelow } from "@/tool/external-directory"
import { Truncate } from "@/tool/truncate"

const checkout = path.join(path.sep, "Users", "dev", "project")
const pool = path.join(checkout, ".agent-duel", "worktrees", "1e5a93c70dbcca48")
const own = path.join(pool, "generation-11-a")
const skill = path.join(path.sep, "Users", "dev", ".agents", "skills", "review")
const sandbox = {
  tmp: ArenaContestant.tmpDirectory("ses_left"),
  blocked: [checkout],
  own: [own, `${own}.git`],
}

/** The asks and allows upstream grants every agent, which the contestant allow must override. */
const agentRules = [
  { permission: "external_directory", pattern: "*", action: "ask" as const },
  { permission: "external_directory", pattern: path.join(Global.Path.tmp, "*"), action: "allow" as const },
  { permission: "external_directory", pattern: Truncate.GLOB, action: "allow" as const },
  { permission: "external_directory", pattern: path.join(skill, "*"), action: "allow" as const },
]

const access = (ruleset: Parameters<typeof Permission.evaluate>[2], directory: string) =>
  Permission.evaluate("external_directory", path.join(directory, "*"), ruleset).action

describe("Arena contestant permissions", () => {
  test("allows everything outside the main checkout, without asking", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))

    for (const directory of [
      "/tmp",
      Global.Path.tmp,
      Truncate.DIR,
      path.join(skill, "references"),
      ArenaContestant.tmpDirectory("ses_right"),
      path.join(path.sep, "Users", "dev"),
      path.join(path.sep, "Users", "dev", "code", "other-project"),
      `${checkout}-backup`,
    ]) {
      expect(access(ruleset, directory)).toBe("allow")
    }
  })

  test("denies the main checkout, the other side's worktree and every earlier turn's", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))

    for (const directory of [
      checkout,
      path.join(checkout, "src"),
      path.join(checkout, ".git"),
      pool,
      path.join(pool, "generation-11-b"),
      path.join(pool, "generation-11-b.git"),
      path.join(pool, "generation-5-b", "src", "scene"),
      path.join(pool, "spare-0a1b2c3d"),
    ]) {
      expect(access(ruleset, directory)).toBe("deny")
    }
  })

  test("reopens the side's own worktree and host repository inside the checkout", () => {
    const ruleset = contestantPermissions(undefined, sandbox)

    expect(access(ruleset, path.join(own, "src"))).toBe("allow")
    expect(access(ruleset, `${own}.git`)).toBe("allow")
    expect(access(ruleset, `${own}-backup`)).toBe("deny")
  })

  test("blocks each spelling it is given, so /private cannot route around /tmp", () => {
    const ruleset = contestantPermissions(undefined, {
      ...sandbox,
      blocked: ["/tmp/project", "/private/tmp/project"],
      own: [],
    })

    expect(access(ruleset, "/tmp/project/src")).toBe("deny")
    expect(access(ruleset, "/private/tmp/project/src")).toBe("deny")
  })

  test("preserves unrelated source permissions", () => {
    const permissions = contestantPermissions([{ permission: "edit", pattern: "*", action: "allow" }], sandbox)

    expect(Permission.evaluate("edit", "src/index.ts", permissions).action).toBe("allow")
    expect(access(permissions, checkout)).toBe("deny")
  })

  test("gives each side its own temp directory", () => {
    const left = contestantPermissions(undefined, sandbox)
    const right = contestantPermissions(undefined, { ...sandbox, tmp: ArenaContestant.tmpDirectory("ses_right") })

    expect(ArenaContestant.sandboxTmp(left)).toBe(sandbox.tmp)
    expect(ArenaContestant.sandboxTmp(right)).toBe(ArenaContestant.tmpDirectory("ses_right"))
    expect(ArenaContestant.sandboxTmp(agentRules)).toBeUndefined()
  })

  test("subagents inherit the sandbox", () => {
    const permission = deriveSubagentSessionPermission({
      parentSessionPermission: contestantPermissions(undefined, sandbox),
      subagent: { permission: [] } as unknown as Parameters<typeof deriveSubagentSessionPermission>[0]["subagent"],
    })

    expect(ArenaContestant.sandboxTmp(permission)).toBe(sandbox.tmp)
    expect(access(permission, path.join(pool, "generation-11-b"))).toBe("deny")
    expect(access(permission, path.join(own, "src"))).toBe("allow")
    expect(access(permission, "/tmp")).toBe("allow")
  })

  test("names the blocked directories for a contestant only", () => {
    expect(ArenaContestant.blockedDirectories(contestantPermissions(agentRules, sandbox))).toEqual([checkout])
    expect(
      ArenaContestant.blockedDirectories([
        { permission: "external_directory", pattern: path.join(checkout, "*"), action: "deny" },
      ]),
    ).toEqual([])
  })

  test("explains a blocked directory without listing the rules", () => {
    const ruleset = contestantPermissions(agentRules, sandbox)
    const other = path.join(pool, "generation-11-b")

    expect(
      ArenaContestant.denial({
        ruleset,
        permission: "external_directory",
        pattern: path.join(other, "*"),
        write: false,
      }),
    ).toBe(
      `Arena contestants cannot access the main checkout or any Arena worktree but their own. ${other} is inside them.`,
    )
    // Any other denial, and every denial outside Arena, keeps the generic message.
    expect(
      ArenaContestant.denial({ ruleset, permission: "external_directory", pattern: "/etc/*", write: false }),
    ).toBeUndefined()
    expect(
      ArenaContestant.denial({
        ruleset: agentRules,
        permission: "external_directory",
        pattern: path.join(checkout, "*"),
        write: false,
      }),
    ).toBeUndefined()
    expect(ArenaContestant.denial({ ruleset, permission: "bash", pattern: "rm", write: false })).toBeUndefined()
  })
})

describe("searches that start above a blocked directory", () => {
  test("leave it out with anchored globs", () => {
    const code = path.join(path.sep, "Users", "dev")
    expect(excludedBelow(code, [checkout])).toEqual(["/project", "/project/**"])
    expect(excludedBelow(path.sep, [checkout])).toEqual(["/Users/dev/project", "/Users/dev/project/**"])
  })

  test("need nothing when the search starts inside or beside it", () => {
    expect(excludedBelow(own, [checkout])).toEqual([])
    expect(excludedBelow(checkout, [checkout])).toEqual([])
    expect(excludedBelow(path.join(path.sep, "Users", "other"), [checkout])).toEqual([])
    expect(excludedBelow(path.join(path.sep, "Users", "dev"), undefined)).toEqual([])
  })

  test("escape glob characters in the path", () => {
    expect(excludedBelow("/Users/dev", ["/Users/dev/a[1]{x}"])).toEqual(["/a\\[1\\]\\{x\\}", "/a\\[1\\]\\{x\\}/**"])
  })
})
