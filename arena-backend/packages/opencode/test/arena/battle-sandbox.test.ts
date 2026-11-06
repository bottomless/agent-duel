import { describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { FileAccess } from "@opencode/core/file-access"
import { FileMutation } from "@opencode/core/file-mutation"
import { Environment } from "@opencode/core/environment/index"
import { Formatter } from "@opencode/core/formatter"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Tool } from "@opencode/schema/tool"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { host } from "../../../core/test/plugin/host"
import { location } from "../../../core/test/fixture/location"
import { AbsolutePath } from "@opencode/core/schema"
import { AssignmentRegistry } from "@/arena/proxy"
import { contestantPermissions, tmpDirectory, tmpParent } from "@/arena/contestant"
import { createArenaEnginePlugin } from "@/arena/engine-runtime/plugin"
import { shellPaths } from "@/arena/engine-runtime/outside-project"
import { Global } from "@opencode/util/global"
import { permissionRules, sandboxForSession } from "@/arena/engine-runtime/sandbox"
import { canonicalizeTranscriptPaths } from "@/arena/canonical-path"
import { battlePathDenial } from "@/arena/engine-runtime/battle-sandbox"

const rootID = Session.ID.make("ses_r04_side")
const childID = Session.ID.make("ses_r04_child")
const grandchildID = Session.ID.make("ses_r04_grandchild")
function call(sessionID = rootID): Tool.Context {
  return {
    sessionID,
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_r04"),
    id: Tool.CallID.make("call_r04"),
    progress: () => Effect.void,
  }
}
function fixture() {
  const checkout = realpathSync(mkdtempSync(path.join(os.tmpdir(), "arena-r04-")))
  const side = path.join(checkout, ".agent-duel/side")
  const other = path.join(checkout, ".agent-duel/other")
  mkdirSync(side, { recursive: true })
  mkdirSync(other)
  const rules = permissionRules(
    [{ action: "*", resource: "*", effect: "allow" }],
    sandboxForSession(rootID, side, checkout),
  )
  return { checkout, side, other, rules, [Symbol.dispose]: () => rmSync(checkout, { recursive: true, force: true }) }
}
function harness(f: ReturnType<typeof fixture>, battle = true, capturedDirectory = f.side, autoAccept = true) {
  const assignments = new AssignmentRegistry()
  assignments.assign(rootID, {
    runID: "run_r04",
    rootSessionID: rootID,
    scopeID: "scope_r04",
    assignmentID: "assignment_r04",
    telemetry: battle,
  })
  const sessions = new Map(
    [rootID, childID, grandchildID].map((id) => [
      id,
      Schema.decodeUnknownSync(Session.Info)({
        id,
        ...(id === rootID ? {} : { parentID: id === childID ? rootID : childID }),
        projectID: "global",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
        location: { directory: id === rootID ? f.side : f.checkout },
        permissions: f.rules,
      }),
    ]),
  )
  const tools = new Map<string, Tool.Info & { id: string }>()
  let evaluate: (event: PermissionEvaluation) => Effect.Effect<void> = () => Effect.void
  let shellHook: (event: ShellCreateBefore) => Effect.Effect<void> = () => Effect.void
  const cards: Permission.AssertInput[] = []
  const executions: ShellCreateBefore[] = []
  const registration = () => Effect.succeed({ dispose: Effect.void })
  const assert = (input: Permission.AssertInput) =>
    Effect.gen(function* () {
      const effect = Permission.evaluate(input.action, input.resources[0], f.rules).effect
      const event: PermissionEvaluation = { ...input, effect }
      if (effect !== "deny") yield* evaluate(event)
      if (event.effect === "ask") cards.push(input)
      if (event.effect !== "allow")
        return yield* new Permission.BlockedError({
          rules: f.rules,
          permission: input.action,
          resources: input.resources,
          reason: event.message,
        })
    })
  const active = location(
    { directory: AbsolutePath.make(capturedDirectory) },
    { projectDirectory: AbsolutePath.make(f.checkout) },
  )
  const context = host({
    location: active,
    provider: { ...host().provider, transform: registration },
    agent: { ...host().agent, transform: registration },
    aisdk: { hook: registration },
    session: { hook: registration, get: ({ sessionID }) => Effect.succeed(sessions.get(sessionID)!) },
    skill: { ...host().skill, list: () => Effect.succeed({ data: [] }) },
    permission: {
      ...host().permission,
      hook: (_name, callback) => {
        evaluate = callback
        return registration()
      },
      assert: (input) =>
        assert(input).pipe(Effect.mapError((error) => new Tool.Error({ message: error.message, error }))),
    },
    shell: {
      hook: (_name, callback) => {
        shellHook = callback
        return registration()
      },
    },
    tool: {
      ...host().tool,
      hook: registration,
      transform: (update) =>
        Effect.sync(() => {
          update({
            list: () => [...tools.values()],
            get: (id) => tools.get(id),
            add: (tool) => {
              tools.set(tool.name, { ...tool, id: tool.name })
            },
            update: (id, edit) => {
              const tool = tools.get(id)
              if (tool) edit(tool)
            },
            remove: (id) => {
              tools.delete(id)
            },
            namespace: () => {},
          })
          return { dispose: Effect.void }
        }),
    },
  })
  tools.set("shell", {
    id: "shell",
    name: "shell",
    description: "Records invocation; never spawns a process",
    input: Schema.Unknown,
    execute: (input) =>
      Effect.gen(function* () {
        const args = Schema.decodeUnknownSync(
          Schema.Struct({ command: Schema.String, workdir: Schema.optionalKey(Schema.String) }),
        )(input)
        const event: ShellCreateBefore = {
          command: args.command,
          cwd: args.workdir ?? capturedDirectory,
          shell: "/bin/sh",
          timeout: 0,
          env: {},
        }
        yield* shellHook(event)
        executions.push(event)
        return { content: "executed" }
      }),
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      FileAccess.node,
      FileMutation.node,
      Environment.node,
      Formatter.node,
      Permission.node,
      Location.node,
    ]),
    [
      Location.node.replace(Layer.succeed(Location.Service, active)),
      Permission.node.replace(Layer.mock(Permission.Service, { assert })),
      Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
    ],
  )
  const install = Effect.gen(function* () {
    yield* WriteTool.Plugin.effect(context)
    yield* EditTool.Plugin.effect(context)
    yield* PatchTool.Plugin.effect(context)
    yield* createArenaEnginePlugin({ enabled: true, assignments, autoAccept }).effect(context)
  })
  const execute = (name: string, input: unknown, sessionID = rootID) => tools.get(name)!.execute(input, call(sessionID))
  return {
    layer,
    install,
    execute,
    cards,
    executions,
    assignments,
    evaluate: (event: PermissionEvaluation) => evaluate(event),
  }
}
function run(h: ReturnType<typeof harness>, effect: Effect.Effect<void, Tool.Error, FileAccess.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* h.install
      yield* effect
    }).pipe(Effect.provide(h.layer), Effect.scoped),
  )
}

describe("battle shell reads and writes", () => {
  it("allows a checkout source without treating it as a copy destination", async () => {
    const command = "cp /checkout/reference.txt /side/copied.txt"
    expect(await shellPaths(command, "/side", "read")).toEqual(["/side/", "/checkout/reference.txt"])
    expect(await shellPaths(command, "/side", "write")).toEqual(["/side/copied.txt"])
  })
  it("confirms Core uses a relative edit resource for checkout files under the Git root", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join(f.checkout, "escape.txt"), kind: "file" })
        expect(target.externalDirectory).toBeUndefined()
        expect(target.resource).toBe("../../escape.txt")
        expect(Permission.evaluate("edit", target.resource, f.rules).effect).toBe("allow")
        expect(battlePathDenial(f.rules, "write", target.resource, f.side)).toContain(
          "write only in their own worktree",
        )
      }).pipe(Effect.orDie),
    )
  })
  it.each([false, true])(
    "denies the real write tool with autoAccept=%s and still writes inside the side",
    async (autoAccept) => {
      using f = fixture()
      const h = harness(f, true, f.side, autoAccept)
      await run(
        h,
        Effect.gen(function* () {
          const denied = yield* h
            .execute("write", { path: path.join(f.checkout, "escape.txt"), content: "outside" })
            .pipe(Effect.result)
          expect(denied).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "Tool.Error", message: expect.stringContaining("write only in their own worktree") },
          })
          yield* h.execute("write", { path: "inside.txt", content: "inside" })
          expect(existsSync(path.join(f.checkout, "escape.txt"))).toBe(false)
          expect(readFileSync(path.join(f.side, "inside.txt"), "utf8")).toBe("inside")
          expect(h.cards).toEqual([])
        }),
      )
    },
  )
  it.each(["touch", "redirect", "tee", "copy", "nested", "find"])(
    "denies checkout writes via %s without executing",
    async (form) => {
      using f = fixture()
      const target = path.join(f.checkout, "escape.txt")
      const commands: Record<string, string> = {
        touch: `touch ${target}`,
        redirect: `echo x > ${target}`,
        tee: `echo x | tee ${target}`,
        copy: `cp source.txt ${target}`,
        nested: `sh -c 'echo x >> ${target}'`,
        find: `find src -type f -exec sh -c 'echo changed >> ${target}' sh {} \\;`,
      }
      const h = harness(f)
      await run(
        h,
        Effect.gen(function* () {
          expect(yield* h.execute("shell", { command: commands[form] }).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringContaining("write only in their own worktree") },
          })
          expect(h.executions).toEqual([])
          expect(h.cards).toEqual([])
        }),
      )
    },
  )
})

describe("side paths and descendants", () => {
  it("gives the first R74-style shell the side cwd even with a checkout-bound executor", async () => {
    using f = fixture()
    const h = harness(f, true, f.checkout)
    const command = `find src -type f -exec sh -c 'echo changed >> "$1"' sh {} \\;`
    await run(
      h,
      Effect.gen(function* () {
        yield* h.execute("shell", { command })
        expect(h.executions).toMatchObject([{ command, cwd: f.side, env: { TMPDIR: tmpDirectory(rootID) } }])
        expect(yield* h.execute("shell", { command, workdir: f.checkout }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("write only") },
        })
        expect(h.executions).toHaveLength(1)
        yield* h.execute("write", { path: "first.txt", content: "side" })
        expect(readFileSync(path.join(f.side, "first.txt"), "utf8")).toBe("side")
        expect(existsSync(path.join(f.checkout, "first.txt"))).toBe(false)
      }),
    )
  })
  it.each([childID, grandchildID])("keeps %s in the parent's side and temp directory", async (id) => {
    using f = fixture()
    const h = harness(f, true, f.checkout)
    await run(
      h,
      Effect.gen(function* () {
        expect(
          yield* h
            .execute("write", { path: path.join(f.checkout, "escape.txt"), content: "outside" }, id)
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        expect(
          yield* h.execute("shell", { command: `touch ${f.checkout}/escape.txt` }, id).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        yield* h.execute("write", { path: "child.txt", content: "child" }, id)
        yield* h.execute("shell", { command: "touch child-shell.txt" }, id)
        expect(readFileSync(path.join(f.side, "child.txt"), "utf8")).toBe("child")
        expect(h.executions).toMatchObject([{ cwd: f.side, env: { TMPDIR: tmpDirectory(rootID) } }])
        expect(h.assignments.assignments.get(id)?.rootSessionID).toBe(rootID)
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("keeps checkout reads, copy sources, and side writes available", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const command of [
          `cat ${f.checkout}/reference.txt`,
          `cp ${f.checkout}/reference.txt copied.txt`,
          "touch own.txt",
          "echo x > own.txt",
          "echo x | tee own.txt",
          `sh -c 'touch nested.txt'`,
        ])
          yield* h.execute("shell", { command })
        expect(h.executions).toHaveLength(6)
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("recognizes the destination of a target-directory copy", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        expect(
          yield* h.execute("shell", { command: `cp -t ${f.checkout} source.txt` }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        yield* h.execute("shell", { command: `cp -t . ${f.checkout}/reference.txt` })
        expect(h.executions).toHaveLength(1)
      }),
    )
  })
  it("distinguishes input redirects from output and permits the null sink", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        yield* h.execute("shell", { command: `cat < ${f.checkout}/reference.txt > /dev/null` })
        expect(
          yield* h.execute("shell", { command: `cat < ${f.other}/private.txt` }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("other Arena worktrees") } })
        expect(h.executions).toHaveLength(1)
      }),
    )
  })
  it("denies write and edit paths through symlinks and permits own symlinks", async () => {
    using f = fixture()
    symlinkSync(f.checkout, path.join(f.side, "checkout-link"))
    mkdirSync(path.join(f.side, "inside"))
    symlinkSync(path.join(f.side, "inside"), path.join(f.side, "inside-link"))
    writeFileSync(path.join(f.checkout, "original.txt"), "before")
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const target of ["../../new.txt", "checkout-link/new/deep.txt", "~/outside.txt"])
          expect(yield* h.execute("write", { path: target, content: "outside" }).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringContaining("write only") },
          })
        expect(
          yield* h
            .execute("edit", { path: "checkout-link/original.txt", oldString: "before", newString: "after" })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        expect(
          yield* h.execute("shell", { command: "echo x > checkout-link/escape.txt" }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        yield* h.execute("write", { path: "inside-link/ok.txt", content: "ok" })
        expect(readFileSync(path.join(f.side, "inside/ok.txt"), "utf8")).toBe("ok")
        expect(readFileSync(path.join(f.checkout, "original.txt"), "utf8")).toBe("before")
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("keeps the shared temp write denial and the side temp grant", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const directory of ["/tmp", realpathSync("/tmp"), "/var/tmp", os.tmpdir()]) {
          expect(
            yield* h.execute("shell", { command: `echo x > ${directory}/r04-shared.txt` }).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("own $TMPDIR") } })
          expect(
            yield* h
              .execute("write", { path: path.join(directory, "r04-shared.txt"), content: "outside" })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" })
        }
        const ownTemp = path.join(tmpDirectory(rootID), "allowed.txt")
        yield* h.execute("write", { path: ownTemp, content: "temp" })
        yield* h.execute("shell", { command: `touch ${ownTemp}` })
        yield* h.execute("shell", { command: "touch $TMPDIR/allowed.txt" })
        expect(readFileSync(ownTemp, "utf8")).toBe("temp")
        expect(
          yield* h.execute("shell", { command: `cat ${tmpParent()}/ses_other/private.txt` }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("another side's temp") } })
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("normalizes relative Core permission resources before the model sees a filesystem ask", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        const event: PermissionEvaluation = {
          sessionID: rootID,
          action: "edit",
          resources: ["../../escape.txt"],
          effect: "ask",
        }
        yield* h.evaluate(event)
        expect(event).toMatchObject({ effect: "deny", message: expect.stringContaining("write only") })
        const own: PermissionEvaluation = { ...event, resources: ["own.txt"], effect: "allow" }
        yield* h.evaluate(own)
        expect(own.effect).toBe("allow")
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("guards patch targets and leaves an own patch usable with a checkout-bound executor", async () => {
    using f = fixture()
    const h = harness(f, true, f.checkout)
    const patch = (target: string) => ({
      patchText: `*** Begin Patch\n*** Add File: ${target}\n+patched\n*** End Patch`,
    })
    await run(
      h,
      Effect.gen(function* () {
        expect(yield* h.execute("patch", patch(path.join(f.checkout, "escape.txt"))).pipe(Effect.result)).toMatchObject(
          { _tag: "Failure", failure: { message: expect.stringContaining("write only") } },
        )
        yield* h.execute("patch", patch("own.txt"))
        expect(readFileSync(path.join(f.side, "own.txt"), "utf8")).toBe("patched\n")
        expect(existsSync(path.join(f.checkout, "escape.txt"))).toBe(false)
        expect(h.cards).toEqual([])
      }),
    )
  })
  it("leaves Battle off shell scans and real file writes unchanged", async () => {
    using f = fixture()
    const h = harness(f, false)
    await run(
      h,
      Effect.gen(function* () {
        yield* h.execute("shell", { command: `touch ${f.checkout}/off.txt` })
        yield* h.execute("shell", { command: "echo x > /tmp/r04-off.txt" })
        yield* h.execute("write", { path: path.join(f.checkout, "off.txt"), content: "off" })
        expect(readFileSync(path.join(f.checkout, "off.txt"), "utf8")).toBe("off")
        expect(h.executions).toHaveLength(2)
        expect(h.cards).toEqual([])
      }),
    )
  })
})

describe("fb3 Git and battle-folder regressions", () => {
  const reads = [
    "log",
    "status",
    "rev-parse HEAD",
    "show HEAD",
    "diff",
    "ls-files",
    "branch --show-current",
    "remote -v",
  ]
  it.each(reads)("allows git %s with and without -C", async (command) => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const prefix of ["git", `git -C ${f.checkout}`])
          yield* h.execute("shell", { command: `${prefix} ${command}` })
        expect(h.executions).toHaveLength(2)
        expect(h.cards).toEqual([])
      }),
    )
    expect(await shellPaths(`git -C ${f.checkout} ${command}`, f.side, "write")).toEqual([])
  })
  it.each([
    "add file",
    "commit",
    "checkout branch",
    "branch new",
    "branch --show-current extra",
    "remote add name url",
    "remote -v extra",
    "-c core.pager=cat log",
    "--config-env=core.pager=GIT_PAGER log",
    "--exec-path=/outside log",
    "--git-dir=/outside log",
    "--work-tree=/outside status",
    "log --output=out",
    "log --output out",
    "diff --ext-diff",
    "show --textconv",
    "status > output.txt",
  ])("treats git %s as a write outside the project", async (command) => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        const redirect = command.includes(">") ? command.replace("output.txt", `${f.checkout}/output.txt`) : command
        expect(
          yield* h.execute("shell", { command: `git -C ${f.checkout} ${redirect}` }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("write only") } })
        expect(h.executions).toEqual([])
      }),
    )
  })
  it.each(reads)("denies git -C into another side for %s", async (command) => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const target of [f.other, `${tmpParent()}/ses_other`]) {
          const result = yield* h.execute("shell", { command: `git -C ${target} ${command}` }).pipe(Effect.result)
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              message: "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
            },
          })
        }
        expect(h.executions).toEqual([])
      }),
    )
  })
  it("names a battle-folder write accurately without disclosing another side", () => {
    using f = fixture()
    expect(battlePathDenial(f.rules, "write", "../build.log", f.side)).toBe(
      "Arena contestants cannot write ../build.log in the battle folder. Write only in your own worktree or your own $TMPDIR.",
    )
    expect(battlePathDenial(f.rules, "write", path.join(f.other, "build.log"), f.side)).toBe(
      "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
    )
    expect(battlePathDenial(f.rules, "read", f.other, f.side)).toBe(
      "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
    )
    symlinkSync(f.side, path.join(f.other, "link"))
    expect(battlePathDenial(f.rules, "read", path.join(f.other, "link"), f.side)).toBe(
      "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
    )
  })
  it("denies the shared shell output folder and gives contestants their own output directory", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        const shared = path.join(Global.Path.data, "shell", "old-project", "user.out")
        expect(battlePathDenial(f.rules, "read", shared, f.side)).toBe(
          "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
        )
        expect(Permission.evaluate("read", shared, f.rules).effect).toBe("deny")
        const serviceRules = contestantPermissions(
          [{ permission: "*", pattern: "*", action: "allow" }],
          sandboxForSession(rootID, f.side, f.checkout),
        ).map((rule) => ({
          action: rule.permission === "external_directory_write" ? "edit" : rule.permission,
          resource: rule.pattern,
          effect: rule.action,
        }))
        expect(Permission.evaluate("read", shared, serviceRules).effect).toBe("deny")
        expect(battlePathDenial(serviceRules, "read", shared, f.side)).toBe(
          "Arena contestants cannot access other Arena worktrees or another side's temp directory.",
        )
        yield* h.execute("shell", { command: "printf side" })
        yield* h.execute("shell", { command: "printf child" }, childID)
        expect(h.executions.map((event) => event.outputDirectory)).toEqual([tmpDirectory(rootID), tmpDirectory(rootID)])
      }),
    )
    const off = harness(f, false)
    await run(
      off,
      Effect.gen(function* () {
        yield* off.execute("shell", { command: "printf off" })
        expect(off.executions.map((event) => event.outputDirectory)).toEqual([undefined])
      }),
    )
  })
})

describe("battle shell writes are the forms that write (bench 2026-11-06)", () => {
  // Commands that contestants ran in the bench, and v2 refused although they write nothing outside
  // their own worktree and temp directory.
  const safe = [
    `curl -sSf -X POST http://127.0.0.1:22015/api/plan -H "Content-Type: application/json" -d '{"job":"Engineer","pain":["wrist","/neck"],"url":"http://127.0.0.1:1/x"}'`,
    `node --input-type=module -e "const r=await fetch('http://127.0.0.1:1/'); console.log(r.status)"`,
    `node -e "require('fs').writeFileSync(process.env.TMPDIR+'/anim.js','x')"`,
    `npm view expo@58.0.23 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d)'`,
    "cd /tmp && npm view express version 2>&1 | tail -3",
    "sed -n '1,120p' /tmp/gully-test.log",
    "awk '/FAIL|Error:/{print}' /tmp/gully-test.log | head -40",
    `cd "$(pwd)" && perl -0pi -e 's/decideResult\\(first, /decideResult(/g' src/scoring.test.ts`,
    "git status --short; curl -s -o /dev/null -w 'preview %{http_code}\\n' http://turn1-a--b40be60e.localhost:6771/",
    `python3 -c "print('a/b'.split('/'))"`,
    "curl -s -o $TMPDIR/page.html https://example.com/",
    "tar -czf $TMPDIR/out.tgz src",
  ]
  it.each(safe)("runs %s", async (command) => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        yield* h.execute("shell", { command })
        expect(h.executions).toHaveLength(1)
        expect(h.cards).toEqual([])
      }),
    )
  })
  const writes = (f: ReturnType<typeof fixture>) => [
    `echo x > ${f.checkout}/escape.txt`,
    `npm install --prefix ${f.checkout}/deps left-pad`,
    `curl -o ${f.checkout}/page.html https://example.com/`,
    `curl -sSo ${f.checkout}/page.html https://example.com/`,
    `wget -O ${f.checkout}/page.html https://example.com/`,
    `sed -i 's/a/b/' ${f.checkout}/file.txt`,
    `sed -i.bak -e 's/a/b/' ${f.checkout}/file.txt`,
    `perl -pi -e 's/a/b/' ${f.checkout}/file.txt`,
    `cp own.txt ${f.checkout}/copy.txt`,
    `mv ${f.checkout}/file.txt own.txt`,
    `tar -xzf own.tgz -C ${f.checkout}`,
    `tar czf ${f.checkout}/out.tgz src`,
    `dd if=/dev/zero of=${f.checkout}/zero bs=1 count=1`,
    `rm -rf ${f.checkout}/src`,
    `find ${f.checkout} -name '*.log' -delete`,
    `bash -c 'touch ${f.checkout}/nested.txt'`,
    `gcc main.c -o ${f.checkout}/a.out`,
  ]
  it("still refuses each write outside the contestant's folders", async () => {
    using f = fixture()
    const h = harness(f)
    await run(
      h,
      Effect.gen(function* () {
        for (const command of writes(f))
          expect({
            command,
            result: yield* h.execute("shell", { command }).pipe(Effect.result),
          }).toMatchObject({
            command,
            result: { _tag: "Failure", failure: { message: expect.stringContaining("write only") } },
          })
        expect(h.executions).toEqual([])
      }),
    )
  })
  it("names the way out of a shared temp write and of a checkout write", async () => {
    using f = fixture()
    const h = harness(f)
    const own = realpathSync(path.dirname(tmpDirectory(rootID)))
    mkdirSync(tmpDirectory(rootID), { recursive: true })
    await run(
      h,
      Effect.gen(function* () {
        const shared = yield* h.execute("shell", { command: "npm test > /tmp/gully-test.log 2>&1" }).pipe(Effect.result)
        expect(shared).toMatchObject({
          _tag: "Failure",
          failure: {
            message: `Arena contestants cannot change files in ${realpathSync("/tmp")}, which both sides use while they run. They write only in their own worktree and their own $TMPDIR: use the same name under $TMPDIR (${path.join(own, path.basename(tmpDirectory(rootID)))}) instead.`,
          },
        })
        const checkout = yield* h.execute("shell", { command: `touch ${f.checkout}/x.txt` }).pipe(Effect.result)
        expect(checkout).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              new RegExp(
                `write only in their own worktree and their own \\$TMPDIR \\(.+\\)\\. ${f.checkout}/x\\.txt is outside them\\.$`,
              ),
            ),
          },
        })
        // The worktree path names the home directory, so the message leaves it out.
        expect(checkout).not.toMatchObject({ failure: { message: expect.stringContaining(`(${f.side})`) } })
        expect(h.executions).toEqual([])
      }),
    )
  })
  it("keeps a computed word a read for a reader and a write for a redirect", async () => {
    expect(await shellPaths(`grep -r foo "$(pwd)/src"`, "/side", "write")).toEqual([])
    expect(await shellPaths(`echo x > "$(mktemp)"`, "/side", "write")).toEqual([])
  })
  it("leaves the ask-before-tools scan of a normal chat as it was", async () => {
    const etc = realpathSync("/etc")
    expect(await shellPaths(`node -e "require('fs').writeFileSync('/etc/x','x')"`, "/side")).toContain(`${etc}/x`)
    expect(await shellPaths("sed -n '1p' /etc/hosts", "/side")).toContain(`${etc}/hosts`)
  })
})

it("winner promotion retargets a native background-shell file before its temp is released", async () => {
  const file = path.join(tmpDirectory("ses_abc123"), "sh_example.out")
  const part = {
    type: "tool",
    name: "shell",
    state: {
      status: "completed",
      content: [{ type: "text", text: `Background command started. Output file: ${file}` }],
      metadata: { file },
    },
  }
  const promoted = await canonicalizeTranscriptPaths(
    part,
    { worktrees: ["/repo/.agent-duel/a"], canonical: "/repo", temp: tmpParent() },
    "assistant",
  )
  expect(promoted.state.content).toEqual([
    { type: "text", text: "Background command started. Output file: $TMPDIR/sh_example.out" },
  ])
  expect(promoted.state.metadata.file).toBe("$TMPDIR/sh_example.out")
})
