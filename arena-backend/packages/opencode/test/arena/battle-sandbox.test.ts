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
  const rules = contestantPermissions([{ permission: "*", pattern: "*", action: "allow" }], {
    tmp: tmpDirectory(rootID),
    readOnly: [checkout],
    blocked: [path.join(checkout, ".agent-duel")],
    own: [side],
  }).map((rule) => ({
    action: rule.permission === "external_directory_write" ? "edit" : rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
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
