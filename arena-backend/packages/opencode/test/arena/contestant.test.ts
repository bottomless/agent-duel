import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@opencode/util/global"
import { Wildcard } from "@opencode/core/util/wildcard"
import { PermissionV1 } from "@/arena/session-runtime"
import { ArenaContestant, contestantPermissions } from "@/arena/contestant"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { excludedBelow } from "@/tool/external-directory"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

const Permission = {
  merge: (...rulesets: PermissionV1.Ruleset[]) => rulesets.flat(),
  evaluate: (permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]) =>
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask" as const,
      permission,
      pattern: "*",
    },
}

const Truncate = { DIR: TRUNCATION_DIR, GLOB: path.join(TRUNCATION_DIR, "*") }

const checkout = path.join(path.sep, "Users", "dev", "project")
const state = path.join(checkout, ".agent-duel")
const pool = path.join(state, "worktrees", "1e5a93c70dbcca48")
const own = path.join(pool, "generation-11-a")
const skill = path.join(path.sep, "Users", "dev", ".agents", "skills", "review")
const sandbox = {
  tmp: ArenaContestant.tmpDirectory("ses_left"),
  readOnly: [checkout],
  blocked: [state],
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
const write = (ruleset: Parameters<typeof Permission.evaluate>[2], directory: string) =>
  Permission.evaluate(ArenaContestant.EXTERNAL_WRITE, path.join(directory, "*"), ruleset).action

describe("Arena contestant permissions", () => {
  test("allows reading everything outside .agent-duel and other sides' temp directories, without asking", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))

    for (const directory of [
      "/tmp",
      Global.Path.tmp,
      Truncate.DIR,
      path.join(skill, "references"),
      path.join(path.sep, "Users", "dev"),
      path.join(path.sep, "Users", "dev", "code", "other-project"),
      `${checkout}-backup`,
      checkout,
      path.join(checkout, "src"),
      path.join(checkout, ".git"),
    ]) {
      expect(access(ruleset, directory)).toBe("allow")
    }
  })

  test("keeps the main checkout and the shared temp directories read-only and everything else writable", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))

    for (const directory of [
      checkout,
      path.join(checkout, "src"),
      path.join(checkout, ".git"),
      "/tmp",
      "/var/tmp",
      os.tmpdir(),
      path.join(os.tmpdir(), "build"),
      Global.Path.tmp,
    ]) {
      expect(write(ruleset, directory)).toBe("deny")
    }
    for (const directory of [sandbox.tmp, path.join(path.sep, "Users", "dev"), `${checkout}-backup`]) {
      expect(write(ruleset, directory)).not.toBe("deny")
    }
  })

  test("blocks the shared temp directories under their real paths too", () => {
    const ruleset = contestantPermissions(undefined, sandbox)

    for (const directory of ["/tmp", "/var/tmp", os.tmpdir()].flatMap(ArenaContestant.spellings)) {
      expect(access(ruleset, directory)).toBe("allow")
      expect(write(ruleset, directory)).toBe("deny")
    }
  })

  test("denies every other side's temp directory and reopens the side's own", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))
    const other = ArenaContestant.tmpDirectory("ses_right")

    for (const directory of ArenaContestant.spellings(other)) {
      expect(access(ruleset, directory)).toBe("deny")
      expect(access(ruleset, path.join(directory, "shots"))).toBe("deny")
    }
    expect(access(ruleset, ArenaContestant.tmpParent())).toBe("deny")
    for (const directory of ArenaContestant.spellings(sandbox.tmp)) {
      expect(access(ruleset, path.join(directory, "shots"))).toBe("allow")
      expect(write(ruleset, path.join(directory, "shots"))).toBe("allow")
    }
  })

  test("denies .agent-duel: the other side's worktree and every earlier turn's", () => {
    const ruleset = Permission.merge(agentRules, contestantPermissions(undefined, sandbox))

    for (const directory of [
      state,
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
    expect(write(ruleset, path.join(own, "src"))).toBe("allow")
    expect(write(ruleset, `${own}.git`)).toBe("allow")
    expect(access(ruleset, `${own}-backup`)).toBe("deny")
  })

  test("blocks each spelling it is given, so /private cannot route around /tmp", () => {
    const ruleset = contestantPermissions(undefined, {
      ...sandbox,
      readOnly: ["/tmp/project", "/private/tmp/project"],
      blocked: ["/tmp/project/.agent-duel", "/private/tmp/project/.agent-duel"],
      own: [],
    })

    expect(write(ruleset, "/tmp/project/src")).toBe("deny")
    expect(write(ruleset, "/private/tmp/project/src")).toBe("deny")
    expect(access(ruleset, "/tmp/project/.agent-duel/worktrees")).toBe("deny")
    expect(access(ruleset, "/private/tmp/project/.agent-duel/worktrees")).toBe("deny")
  })

  test("preserves unrelated source permissions", () => {
    const permissions = contestantPermissions([{ permission: "edit", pattern: "*", action: "allow" }], sandbox)

    expect(Permission.evaluate("edit", "src/index.ts", permissions).action).toBe("allow")
    expect(access(permissions, checkout)).toBe("allow")
    expect(access(permissions, pool)).toBe("deny")
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
    expect(write(permission, checkout)).toBe("deny")
  })

  test("names the blocked directories for a contestant only", () => {
    expect(ArenaContestant.blockedDirectories(contestantPermissions(agentRules, sandbox))).toEqual([
      ...ArenaContestant.spellings(ArenaContestant.tmpParent()),
      state,
    ])
    expect(
      ArenaContestant.blockedDirectories([
        { permission: "external_directory", pattern: path.join(state, "*"), action: "deny" },
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
    ).toBe(`Arena contestants cannot access any Arena worktree but their own. ${other} is inside them.`)
    expect(
      ArenaContestant.denial({
        ruleset,
        permission: "external_directory",
        pattern: path.join(checkout, "src", "*"),
        write: true,
      }),
    ).toBe(
      `Arena contestants can read the main checkout but change files only in their own worktree. ${path.join(checkout, "src")} is in the main checkout.`,
    )
    expect(ArenaContestant.denial({ ruleset, permission: "external_directory", pattern: "/tmp/*", write: true })).toBe(
      `Arena contestants cannot change files in /tmp, which both sides use while they run. Use the same name under $TMPDIR (${sandbox.tmp}) instead.`,
    )
    expect(
      ArenaContestant.denial({
        ruleset,
        permission: "external_directory",
        pattern: path.join(os.tmpdir(), "build", "*"),
        write: true,
      }),
    ).toBe(
      `Arena contestants cannot change files in ${os.tmpdir()}, which both sides use while they run. Use the same name under $TMPDIR (${sandbox.tmp}) instead.`,
    )
    const otherTmp = ArenaContestant.tmpDirectory("ses_right")
    expect(
      ArenaContestant.denial({
        ruleset,
        permission: "external_directory",
        pattern: path.join(otherTmp, "*"),
        write: false,
      }),
    ).toBe(`Arena contestants can use only their own temp directory, $TMPDIR (${sandbox.tmp}), not ${otherTmp}.`)
    // Any other denial, and every denial outside Arena, keeps the generic message.
    expect(
      ArenaContestant.denial({ ruleset, permission: "external_directory", pattern: "/etc/*", write: false }),
    ).toBeUndefined()
    expect(
      ArenaContestant.denial({
        ruleset: agentRules,
        permission: "external_directory",
        pattern: path.join(pool, "*"),
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
