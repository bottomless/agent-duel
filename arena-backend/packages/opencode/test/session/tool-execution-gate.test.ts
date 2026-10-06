import { describe, expect, test } from "bun:test"
import {
  assertToolExecutionUsable,
  canExecuteDuringEnvironmentSetup,
  clearToolExecutionEnvironment,
  gateToolExecution,
  isToolExecutionGated,
  readyToolExecutionEnvironment,
  relocateHostPaths,
  toolExecutionProvider,
  toolExecutionWorktree,
  waitForToolExecution,
} from "@/session/tool-execution-gate"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { mkdir, readFile, symlink, writeFile } from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

const environment = {
  worktree: "/repo/worktree",
  copiedPaths: ["node_modules", "packages/app/.env"],
  provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
}

describe("tool execution gate", () => {
  test("rejects late tool calls after environment setup failed", async () => {
    const sessionID = SessionID.make("session-late-failure")
    const gate = gateToolExecution(sessionID, environment)
    try {
      gate.fail(new Error("copy failed"))
      gate.release()
      expect(isToolExecutionGated(sessionID)).toBe(true)
      await expect(
        waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "node_modules/pkg/index.js" } }),
      ).rejects.toThrow("copy failed")
      await expect(waitForToolExecution(sessionID, { toolID: "todowrite", args: {} })).rejects.toThrow("copy failed")
    } finally {
      gate.dispose()
    }
    expect(isToolExecutionGated(sessionID)).toBe(false)
  })

  test("observes failure while checking whether a tool can bypass the gate", async () => {
    const sessionID = SessionID.make("session-failure-during-check")
    const gate = gateToolExecution(sessionID, environment)
    const waiting = waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "package.json" } })
    gate.fail(new Error("copy failed during path check"))
    try {
      await expect(waiting).rejects.toThrow("copy failed during path check")
    } finally {
      gate.dispose()
    }
  })

  test("refuses a tool that passed the gate once setup fails before it runs", async () => {
    const sessionID = SessionID.make("session-failure-after-pass")
    const gate = gateToolExecution(sessionID, environment)
    try {
      gate.baseReady()
      await waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "package.json" } })
      expect(() => assertToolExecutionUsable(sessionID)).not.toThrow()
      gate.fail(new Error("copy failed while taking the snapshot"))
      expect(() => assertToolExecutionUsable(sessionID)).toThrow("copy failed while taking the snapshot")
    } finally {
      gate.dispose()
    }
    const released = gateToolExecution(sessionID, environment)
    released.release()
    expect(() => assertToolExecutionUsable(sessionID)).not.toThrow()
    released.dispose()
  })

  test("disposal rejects pending work and does not clear a later gate", async () => {
    const sessionID = SessionID.make("session-disposed")
    const gate = gateToolExecution(sessionID, environment)
    const waiting = waitForToolExecution(sessionID, { toolID: "bash", args: { command: "npm test" } })
    gate.dispose()
    await expect(waiting).rejects.toThrow("Environment setup gate disposed")
    expect(isToolExecutionGated(sessionID)).toBe(false)
    const next = gateToolExecution(sessionID, environment)
    try {
      gate.dispose()
      gate.release()
      expect(isToolExecutionGated(sessionID)).toBe(true)
    } finally {
      next.dispose()
    }
  })

  test("holds broad searches that can override ignored dependency roots", async () => {
    await using directory = await tmpdir({ git: true })
    await mkdir(`${directory.path}/node_modules/pkg`, { recursive: true })
    await mkdir(`${directory.path}/src`)
    await writeFile(`${directory.path}/.gitignore`, "node_modules/\n")
    await writeFile(`${directory.path}/node_modules/pkg/index.js`, "partial dependency\n")
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    for (const toolID of ["glob", "grep"]) {
      const args = toolID === "glob" ? { pattern: "**" } : { pattern: "dependency", include: "**" }
      expect(await canExecuteDuringEnvironmentSetup(pending, { toolID, args })).toBe(false)
      expect(await canExecuteDuringEnvironmentSetup(pending, { toolID, args: { ...args, path: "src" } })).toBe(true)
      const sessionID = SessionID.make(`session-search-${toolID}`)
      const gate = gateToolExecution(sessionID, pending)
      const abort = new AbortController()
      abort.abort(new Error("search cancelled while copying"))
      try {
        await expect(waitForToolExecution(sessionID, { toolID, args }, abort.signal)).rejects.toThrow(
          "search cancelled while copying",
        )
        await writeFile(`${directory.path}/node_modules/pkg/index.js`, "complete dependency\n")
        gate.release()
        await waitForToolExecution(sessionID, { toolID, args })
        expect(await readFile(`${directory.path}/node_modules/pkg/index.js`, "utf8")).toBe("complete dependency\n")
      } finally {
        gate.release()
      }
    }
  })

  test("resolves search paths and shell working directories through links", async () => {
    await using directory = await tmpdir()
    await mkdir(`${directory.path}/node_modules/pkg`, { recursive: true })
    await symlink("node_modules", `${directory.path}/deps`)
    await symlink("deps", `${directory.path}/deps-chain`)
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    for (const toolID of ["glob", "grep"]) {
      expect(await canExecuteDuringEnvironmentSetup(pending, { toolID, args: { path: "deps-chain/pkg" } })).toBe(false)
      expect(await canExecuteDuringEnvironmentSetup(pending, { toolID, args: {} })).toBe(false)
    }
    expect(
      await canExecuteDuringEnvironmentSetup(pending, {
        toolID: "bash",
        args: { command: "git status", workdir: "deps" },
      }),
    ).toBe(false)
    expect(
      await canExecuteDuringEnvironmentSetup(pending, {
        toolID: "read",
        args: { filePath: "deps-chain/pkg/not-copied-yet.js" },
      }),
    ).toBe(false)
  })

  test("holds dangling links but permits unrelated source before the copied root exists", async () => {
    await using directory = await tmpdir()
    await symlink("node_modules", `${directory.path}/deps`)
    await writeFile(`${directory.path}/source.ts`, "source")
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    expect(
      await canExecuteDuringEnvironmentSetup(pending, { toolID: "read", args: { filePath: "deps/pkg/index.js" } }),
    ).toBe(false)
    expect(await canExecuteDuringEnvironmentSetup(pending, { toolID: "read", args: { filePath: "source.ts" } })).toBe(
      true,
    )
    expect(
      await canExecuteDuringEnvironmentSetup(pending, { toolID: "bash", args: { command: "git status --short" } }),
    ).toBe(true)
  })

  test("holds output options including abbreviations and shell quoting", async () => {
    for (const command of [
      "git diff --output=node_modules/diff.txt",
      "git diff --output node_modules/diff.txt",
      "git diff --outp=node_modules/diff.txt",
      "git diff '--output=node_modules/diff.txt'",
      'git diff --out"put"=node_modules/diff.txt',
      "git diff --out\\put=node_modules/diff.txt",
      "git log --output=node_modules/log.txt",
      "git show --output=node_modules/show.txt",
    ]) {
      expect(await canExecuteDuringEnvironmentSetup(environment, { toolID: "bash", args: { command } })).toBe(false)
    }
    for (const command of [
      "git status --short",
      "git diff --stat",
      "git log --oneline",
      "git show HEAD",
      "git diff -- src/index.ts",
    ]) {
      expect(await canExecuteDuringEnvironmentSetup(environment, { toolID: "bash", args: { command } })).toBe(true)
    }
  })

  test("holds git diff output writes while allowing an ordinary Git read", async () => {
    await using directory = await tmpdir({ git: true })
    await writeFile(`${directory.path}/source.txt`, "before\n")
    await $`git add source.txt`.cwd(directory.path).quiet()
    await $`git commit -m "test: tracked source"`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/source.txt`, "after\n")
    await mkdir(`${directory.path}/node_modules`, { recursive: true })
    const output = `${directory.path}/node_modules/diff.txt`
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    const sessionID = SessionID.make("session-git-output")
    const gate = gateToolExecution(sessionID, pending)
    gate.baseReady()
    const execution = { toolID: "bash", args: { command: "git diff --output=node_modules/diff.txt" } }
    try {
      expect(await canExecuteDuringEnvironmentSetup(pending, execution)).toBe(false)
      await waitForToolExecution(sessionID, { toolID: "bash", args: { command: "git diff --stat" } })
      expect(await $`git diff --stat`.cwd(directory.path).text()).toContain("source.txt")
      const waiting = waitForToolExecution(sessionID, execution).then(async () => {
        await $`git diff --output=node_modules/diff.txt`.cwd(directory.path).quiet()
        return "written"
      })
      expect(await Promise.race([waiting, Bun.sleep(25).then(() => "held")])).toBe("held")
      expect(await Bun.file(output).exists()).toBe(false)
      gate.release()
      expect(await waiting).toBe("written")
      expect(await readFile(output, "utf8")).toContain("+after")
    } finally {
      gate.release()
    }
  })

  test("holds a dependency read through a symlink until copying finishes", async () => {
    await using directory = await tmpdir()
    await mkdir(`${directory.path}/node_modules/pkg`, { recursive: true })
    await writeFile(`${directory.path}/node_modules/pkg/index.js`, "partial")
    await writeFile(`${directory.path}/source.ts`, "source")
    await symlink("node_modules", `${directory.path}/deps`)
    await symlink("source.ts", `${directory.path}/source-link.ts`)
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    const sessionID = SessionID.make("session-symlink-read")
    const gate = gateToolExecution(sessionID, pending)
    gate.baseReady()
    const execution = { toolID: "read", args: { filePath: `${directory.path}/deps/pkg/index.js` } }
    try {
      expect(await canExecuteDuringEnvironmentSetup(pending, execution)).toBe(false)
      await waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "source-link.ts" } })
      expect(await readFile(`${directory.path}/source-link.ts`, "utf8")).toBe("source")
      const waiting = waitForToolExecution(sessionID, execution).then(() => readFile(execution.args.filePath, "utf8"))
      expect(await Promise.race([waiting, Bun.sleep(25).then(() => "held")])).toBe("held")
      await writeFile(`${directory.path}/node_modules/pkg/index.js`, "complete")
      gate.release()
      expect(await waiting).toBe("complete")
    } finally {
      gate.release()
    }
  })

  test("holds execution until the environment is released", async () => {
    const sessionID = SessionID.make("session-gated")
    const gate = gateToolExecution(sessionID, environment)
    let executed = false
    const waiting = waitForToolExecution(sessionID, { toolID: "bash", args: { command: "npm test" } }).then(() => {
      executed = true
    })

    await Promise.resolve()
    expect(executed).toBe(false)
    expect(isToolExecutionGated(sessionID)).toBe(true)
    gate.baseReady()
    await Promise.resolve()
    expect(executed).toBe(false)
    gate.release()
    await waiting
    expect(executed).toBe(true)
    expect(isToolExecutionGated(sessionID)).toBe(false)
    expect(readyToolExecutionEnvironment(sessionID)?.worktree).toBe(environment.worktree)
    clearToolExecutionEnvironment(sessionID)
  })

  test("holds removed roots until the environment is released", async () => {
    await using directory = await tmpdir()
    await writeFile(`${directory.path}/source.ts`, "source")
    const pending = {
      worktree: directory.path,
      copiedPaths: ["node_modules"],
      removedPaths: ["stale-cache"],
    }

    expect(
      await canExecuteDuringEnvironmentSetup(pending, {
        toolID: "read",
        args: { filePath: "stale-cache/missing.json" },
      }),
    ).toBe(false)
    expect(await canExecuteDuringEnvironmentSetup(pending, { toolID: "read", args: { filePath: "." } })).toBe(false)
    expect(await canExecuteDuringEnvironmentSetup(pending, { toolID: "glob", args: { path: "stale-cache" } })).toBe(
      false,
    )
    expect(await canExecuteDuringEnvironmentSetup(pending, { toolID: "grep", args: {} })).toBe(false)
    expect(await canExecuteDuringEnvironmentSetup(pending, { toolID: "read", args: { filePath: "source.ts" } })).toBe(
      true,
    )

    const sessionID = SessionID.make("session-removed-root")
    const gate = gateToolExecution(sessionID, pending)
    const execution = { toolID: "read", args: { filePath: "stale-cache/missing.json" } }
    const waiting = waitForToolExecution(sessionID, execution)
    try {
      expect(await Promise.race([waiting.then(() => "released"), Bun.sleep(25).then(() => "held")])).toBe("held")
      gate.release()
      await waiting
    } finally {
      gate.release()
    }
  })

  test("propagates environment setup failure", async () => {
    const sessionID = SessionID.make("session-failed")
    const gate = gateToolExecution(sessionID, environment)
    const waiting = waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "node_modules/pkg/index.js" } })
    gate.fail(new Error("environment failed"))
    let failure: unknown
    try {
      await waiting
    } catch (error) {
      failure = error
    } finally {
      gate.dispose()
    }
    if (!(failure instanceof Error)) throw failure
    expect(failure.message).toBe("environment failed")
  })

  test("lets an environment-independent tool run before the base checkout", async () => {
    const sessionID = SessionID.make("session-safe-tool")
    const gate = gateToolExecution(sessionID, environment)
    await waitForToolExecution(sessionID, { toolID: "websearch", args: { query: "example" } })
    expect(isToolExecutionGated(sessionID)).toBe(true)
    gate.release()
    clearToolExecutionEnvironment(sessionID)
  })

  test("holds project skills until the contestant copy finishes", async () => {
    const sessionID = SessionID.make("session-project-skill")
    const gate = gateToolExecution(sessionID, environment)
    const execution = { toolID: "skill", args: { name: "qa-path-probe" } }
    const waiting = waitForToolExecution(sessionID, execution).then(() => "released")
    const held = () => Promise.race([waiting, Bun.sleep(25).then(() => "held")])
    try {
      expect(await canExecuteDuringEnvironmentSetup(environment, execution)).toBe(false)
      expect(await held()).toBe("held")
      expect(readyToolExecutionEnvironment(sessionID)).toBeUndefined()
      gate.baseReady()
      expect(readyToolExecutionEnvironment(sessionID)?.worktree).toBe(environment.worktree)
      expect(await held()).toBe("held")
      gate.release()
      expect(await waiting).toBe("released")
    } finally {
      gate.release()
      clearToolExecutionEnvironment(sessionID)
    }
  })

  test("releases tracked-file reads only after the base checkout is ready", async () => {
    const sessionID = SessionID.make("session-base-ready")
    const gate = gateToolExecution(sessionID, environment)
    let executed = false
    const waiting = waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "package.json" } }).then(() => {
      executed = true
    })

    await Promise.resolve()
    expect(executed).toBe(false)
    expect(readyToolExecutionEnvironment(sessionID)).toBeUndefined()
    gate.baseReady()
    await waiting
    expect(executed).toBe(true)
    expect(readyToolExecutionEnvironment(sessionID)?.worktree).toBe(environment.worktree)
    gate.release()
    clearToolExecutionEnvironment(sessionID)
  })

  test("keeps a pending-root read held after the base checkout, until release", async () => {
    await using directory = await tmpdir()
    await writeFile(`${directory.path}/source.ts`, "source")
    const pending = { worktree: directory.path, copiedPaths: ["node_modules"] }
    const sessionID = SessionID.make("session-base-then-ignored")
    const gate = gateToolExecution(sessionID, pending)
    const held = (execution: { toolID: string; args: Record<string, unknown> }) =>
      Promise.race([
        waitForToolExecution(sessionID, execution).then(() => "released"),
        Bun.sleep(25).then(() => "held"),
      ])
    try {
      const dependency = waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "node_modules/x.js" } })
      const source = waitForToolExecution(sessionID, { toolID: "read", args: { filePath: "source.ts" } })
      expect(await held({ toolID: "read", args: { filePath: "source.ts" } })).toBe("held")
      gate.baseReady(["stale-cache"])
      await source
      expect(await held({ toolID: "read", args: { filePath: "node_modules/x.js" } })).toBe("held")
      expect(await held({ toolID: "read", args: { filePath: "stale-cache/old.json" } })).toBe("held")
      gate.release()
      await dependency
      expect(isToolExecutionGated(sessionID)).toBe(false)
    } finally {
      gate.dispose()
    }
  })

  test("names the contestant worktree only for a request hosted by another instance", () => {
    const hosted = SessionID.make("session-hosted")
    const local = SessionID.make("session-local")
    const hostedGate = gateToolExecution(hosted, environment)
    const localGate = gateToolExecution(local, { worktree: "/repo/local", copiedPaths: [] })
    try {
      expect(toolExecutionWorktree(hosted)).toBe(environment.worktree)
      expect(toolExecutionProvider(hosted)).toBe(environment.provide)
      expect(toolExecutionWorktree(local)).toBeUndefined()
      hostedGate.release()
      expect(toolExecutionWorktree(hosted)).toBe(environment.worktree)
      hostedGate.dispose()
      expect(toolExecutionWorktree(hosted)).toBeUndefined()
    } finally {
      hostedGate.dispose()
      localGate.dispose()
    }
  })

  test("names the contestant's copies of files a hosted request found in its host checkout", () => {
    const host = "/repo/chat"
    const worktree = "/repo/chat/.agent-duel/worktrees/abc/generation-1-a"
    const system = [
      `Instructions from: ${host}/AGENTS.md`,
      `<location>${host}/.claude/skills/deploy/SKILL.md</location>`,
      `Working directory: ${worktree}`,
      `Sibling: ${host}-other/AGENTS.md and ${host}`,
    ].join("\n")
    expect(relocateHostPaths(system, host, worktree).split("\n")).toEqual([
      `Instructions from: ${worktree}/AGENTS.md`,
      `<location>${worktree}/.claude/skills/deploy/SKILL.md</location>`,
      `Working directory: ${worktree}`,
      `Sibling: ${host}-other/AGENTS.md and ${worktree}`,
    ])
    expect(relocateHostPaths(system, worktree, worktree)).toBe(system)
  })

  test("allows tools that cannot depend on pending ignored content", async () => {
    expect(await canExecuteDuringEnvironmentSetup(environment, { toolID: "todowrite", args: {} })).toBe(true)
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "read",
        args: { filePath: "/repo/worktree/package.json" },
      }),
    ).toBe(true)
    expect(await canExecuteDuringEnvironmentSetup(environment, { toolID: "glob", args: { pattern: "**/*.ts" } })).toBe(
      false,
    )
    expect(
      await canExecuteDuringEnvironmentSetup(environment, { toolID: "bash", args: { command: "git status" } }),
    ).toBe(true)
  })

  test("holds Git listings of ignored files, including bundled and abbreviated options", async () => {
    const allowed = async (command: string) =>
      await canExecuteDuringEnvironmentSetup(environment, { toolID: "bash", args: { command } })
    for (const command of [
      "git ls-files -i -o --exclude-standard",
      "git ls-files -io --exclude-standard",
      "git ls-files -oi --exclude-standard",
      "git ls-files --ignored --others --exclude-standard",
      "git ls-files --ig -c --exclude-standard",
      "git ls-files -o",
      "git ls-files --oth",
      "git ls-files -o --exclude-per-directory=.gitignore",
      "git ls-files -k",
    ])
      expect(await allowed(command)).toBe(false)
    for (const command of ["git ls-files", "git ls-files -o --exclude-standard", "git ls-files -s src", "git log -i"])
      expect(await allowed(command)).toBe(true)
  })

  test("holds tools that can observe or change pending ignored content", async () => {
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "read",
        args: { filePath: "/repo/worktree/node_modules/pkg/index.js" },
      }),
    ).toBe(false)
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "read",
        args: { filePath: "/repo/worktree" },
      }),
    ).toBe(false)
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "bash",
        args: { command: "git status && npm test" },
      }),
    ).toBe(false)
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "bash",
        args: { command: "git diff --no-index package.json node_modules/pkg/package.json" },
      }),
    ).toBe(false)
    expect(
      await canExecuteDuringEnvironmentSetup(environment, {
        toolID: "write",
        args: { filePath: "/repo/worktree/src/new.ts" },
      }),
    ).toBe(false)
    expect(await canExecuteDuringEnvironmentSetup(environment, { toolID: "apply_patch", args: {} })).toBe(false)
  })
})
