import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { define } from "@opencode/plugin/effect/plugin"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionExecution } from "@opencode/core/session/execution"
import { Shell } from "@opencode/core/shell"
import { Job } from "@opencode/core/job"
import { Tool } from "@opencode/core/tool"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AssignmentRegistry } from "@/arena/proxy"
import { createArenaEnginePlugin } from "@/arena/engine-runtime/plugin"
import {
  cancelSessionShells,
  closeShellTurn,
  contestantShellInput,
  contestantShellTimeoutMessage,
  openShellTurn,
  shellNotification,
} from "@/arena/engine-runtime/shell"

test("contestant foreground timeouts default to two minutes and honor requests up to ten minutes", () => {
  for (const [requested, applied] of [
    [undefined, 120_000],
    [0, 120_000],
    [25, 25],
    [240_000, 240_000],
    [600_000, 600_000],
    [600_001, 600_000],
    [2_147_483_647, 600_000],
  ]) {
    expect(contestantShellInput({ command: "sleep 9999", timeout: requested })).toEqual({
      command: "sleep 9999",
      timeout: applied,
    })
  }
  expect(contestantShellInput({ command: "sleep 9999" })).toEqual({
    command: "sleep 9999",
    timeout: 120_000,
  })
  const background = { command: "sleep 9999", background: true, timeout: 0 }
  expect(contestantShellInput(background)).toBe(background)
})

test("contestant timeout advice states the applied limit and directs long commands to the background", () => {
  for (const timeout of [120_000, 240_000, 600_000]) {
    expect(contestantShellTimeoutMessage(timeout)).toBe(
      `Command exceeded the foreground timeout limit of ${timeout} ms. Use background: true for a server or a long-running command.`,
    )
  }
})

test("delivery and side closure serialize; old results cannot reach a reply or the next turn", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const delivered: string[] = []
        yield* openShellTurn("a")
        yield* openShellTurn("b")
        const notifyA = shellNotification("a")
        const notifyB = shellNotification("b")
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const admission = yield* notifyA(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            delivered.push("before close")
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const closing = yield* closeShellTurn(
          "a",
          Effect.sync(() => {
            expect(delivered).toEqual(["before close"])
            return false
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(admission)
        yield* Fiber.join(closing)
        yield* notifyA(
          Effect.sync(() => {
            delivered.push("after final answer")
          }),
        )
        yield* openShellTurn("a")
        yield* notifyA(
          Effect.sync(() => {
            delivered.push("after vote / old generation")
          }),
        )
        yield* shellNotification("a")(
          Effect.sync(() => {
            delivered.push("new reply")
          }),
        )
        yield* notifyB(
          Effect.sync(() => {
            delivered.push("other contestant")
          }),
        )
        expect(delivered).toEqual(["before close", "new reply", "other contestant"])
        yield* closeShellTurn("a", Effect.succeed(false))
        yield* closeShellTurn("b", Effect.succeed(false))
      }),
    ).pipe(Effect.timeout("5 seconds")),
  )
})

interface Fixture {
  readonly execute: (
    sessionID: Session.ID,
    input: Record<string, unknown>,
  ) => Promise<Effect.Success<ReturnType<Tool.Snapshot["execute"]>>>
  readonly shell: Shell.Interface
  readonly root: Effect.Success<ReturnType<Session.Interface["create"]>>
  readonly child: Fixture["root"]
  readonly other: Fixture["root"]
  readonly sessions: Session.Interface
  readonly jobs: Job.Interface
  readonly directory: string
  readonly timeouts: number[]
  readonly dispose: () => Promise<void>
}

// Native tools, jobs, processes and an in-memory database. No HTTP listener, daemon or model calls.
async function fixture(body: (input: Fixture) => Promise<void>) {
  const scope = Scope.makeUnsafe()
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "arena-async-shell-")))
  const assignments = new AssignmentRegistry()
  const timeouts: number[] = []
  async function setup() {
    const extension = Layer.effectDiscard(
      Effect.gen(function* () {
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(
          createArenaEnginePlugin({
            enabled: true,
            assignments,
            autoAccept: true,
            previewEnvironment: () => ({}),
            gate: () => Effect.void,
          }),
        )
        yield* sdk.register(
          define({
            id: "test-shell-deadline",
            effect: (ctx) =>
              ctx.shell
                .hook("create.before", (event) =>
                  Effect.sync(() => {
                    timeouts.push(event.timeout)
                    // Exercise the timer without waiting minutes; record the production deadline first.
                    if (event.command === "sleep 60; printf foreground" && event.timeout > 0) event.timeout = 25
                  }),
                )
                .pipe(Effect.asVoid),
          }),
        )
      }),
    )
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        createRoutes(
          {
            app: { version: "test" },
            database: { path: ":memory:" },
            fs: { filewatcher: false },
            models: { fetch: false },
          },
          () => [],
          [SessionExecution.node.replace(SessionExecution.noopLayer)],
          extension,
        ).pipe(Layer.provide(HttpServer.layerServices)),
        scope,
      ),
    )
    const sessions = Context.get(context, Session.Service)
    const jobs = Context.get(context, Job.Service)
    const permissions = [
      { action: "shell", resource: "*", effect: "allow" as const },
      { action: "external_directory", resource: "*", effect: "deny" as const },
      { action: "external_directory", resource: path.join(directory, "*"), effect: "allow" as const },
      { action: "edit", resource: path.join(directory, "*"), effect: "allow" as const },
    ]
    const location = { directory: AbsolutePath.make(directory) }
    const root = await Effect.runPromise(sessions.create({ location, permissions }))
    const other = await Effect.runPromise(sessions.create({ location, permissions }))
    const child = await Effect.runPromise(sessions.create({ parentID: root.id, permissions }))
    for (const info of [root, child])
      assignments.assign(info.id, {
        runID: "run",
        rootSessionID: root.id,
        scopeID: "turn",
        assignmentID: "assignment",
        telemetry: true,
      })
    await Effect.runPromise(openShellTurn(root.id))
    const locations = Context.get(context, LocationServiceMap.Service)
    const layer = locations.get(root.location)
    const native = await Effect.runPromise(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.awaitActivation
        return { shell: yield* Shell.Service, tools: yield* Tool.Service }
      }).pipe(Effect.provide(layer)),
    )
    let ordinal = 0
    function execute(sessionID: Session.ID, input: Record<string, unknown>) {
      return Effect.runPromise(
        native.tools.snapshot().pipe(
          Effect.flatMap((tools) =>
            tools.execute({
              sessionID,
              agent: Agent.ID.make("code"),
              messageID: SessionMessage.ID.create(),
              call: { type: "tool-call", id: `call-${ordinal++}`, name: "shell", input },
            }),
          ),
          Effect.timeout("10 seconds"),
        ),
      )
    }
    return {
      ...native,
      execute,
      root,
      child,
      other,
      sessions,
      jobs,
      directory,
      timeouts,
      dispose: () => Effect.runPromise(locations.invalidate(root.location)),
    }
  }
  try {
    await body(await setup())
  } finally {
    for (const id of assignments.assignments.keys()) await Effect.runPromise(closeShellTurn(id, Effect.succeed(false)))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}

async function drainNotification(jobs: Job.Interface, shellID: string) {
  await Effect.runPromise(jobs.wait({ id: shellID }).pipe(Effect.timeout("5 seconds")))
  for (let i = 0; i < 1000; i++) {
    const pending = await Effect.runPromise(jobs.pendingBackground)
    if (!pending.some((entry) => entry.recovery.kind === "shell" && entry.recovery.shellID === shellID)) return
    await Bun.sleep(1)
  }
  throw new Error("shell notification did not finish")
}

async function expectProcessGroupEnded(
  pid: number | undefined,
  signal: (group: number) => unknown = (group) => process.kill(group, 0),
) {
  if (pid === undefined || pid <= 1) throw new Error("shell process group missing")
  for (let i = 0; i < 1000; i++) {
    try {
      signal(-pid)
    } catch (error) {
      // macOS can keep a zombie-only group visible but unsignalable (EPERM).
      if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) return
      throw error
    }
    await Bun.sleep(1)
  }
  throw new Error(`shell process group ${pid} survived cleanup`)
}

test("process-death assertions accept absent or unsignalable groups and propagate other errors", async () => {
  for (const code of ["ESRCH", "EPERM"]) {
    await expectProcessGroupEnded(12345, (group) => {
      expect(group).toBe(-12345)
      throw Object.assign(new Error(code), { code })
    })
  }
  const error = Object.assign(new Error("unexpected signal failure"), { code: "EIO" })
  const failure = await expectProcessGroupEnded(12345, () => {
    throw error
  }).catch((cause: unknown) => cause)
  expect(failure).toBe(error)
})

test("native contestant and child shells enforce the deadline; ordinary shells keep their requested timeout", async () => {
  await fixture(async ({ execute, root, child, other, timeouts }) => {
    for (const info of [root, child]) {
      for (const [timeout, applied] of [
        [undefined, 120_000],
        [0, 120_000],
        [240_000, 240_000],
        [600_000, 600_000],
        [2_147_483_647, 600_000],
      ]) {
        const input = timeout === undefined ? {} : { timeout }
        const result = await execute(info.id, { command: "sleep 60; printf foreground", ...input })
        expect(timeouts.at(-1)).toBe(applied)
        expect(result.metadata).toMatchObject({ timeout: true })
        expect(result.content).toContainEqual({
          type: "text",
          text: expect.stringContaining(
            "Command exceeded the foreground timeout limit of 25 ms. Use background: true for a server or a long-running command.",
          ),
        })
        expect(JSON.stringify(result.content)).not.toContain("Retry with a larger timeout")
      }
    }
    const timedOut = await execute(other.id, { command: "sleep 60; printf foreground", timeout: 42 })
    expect(timeouts.at(-1)).toBe(42)
    expect(timedOut.metadata).toMatchObject({ timeout: true })
    expect(timedOut.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(
        "Command exceeded timeout of 25 ms. Retry with a larger timeout if the command is expected to take longer.",
      ),
    })
    const ordinary = await execute(other.id, { command: "printf ordinary", timeout: 0 })
    expect(timeouts.at(-1)).toBe(0)
    expect(ordinary.metadata).toMatchObject({ status: "completed", exit: 0 })
  })
}, 30_000)

test("open contestants receive completed output; ordinary sessions keep Core's default notification", async () => {
  await fixture(async ({ execute, root, other, sessions, jobs, directory }) => {
    for (const info of [root, other]) {
      const result = await execute(info.id, {
        command: "while [ ! -e notify ]; do sleep 0.01; done; printf early-result",
        background: true,
      })
      const shellID = result.metadata?.shellID
      if (typeof shellID !== "string") throw new Error("shell ID missing")
      await writeFile(path.join(directory, "notify"), "")
      await drainNotification(jobs, shellID)
      expect(await Effect.runPromise(sessions.inbox(info.id))).toMatchObject([
        {
          type: "synthetic",
          payload: { text: expect.stringContaining("early-result"), metadata: { source: "shell", shellID } },
        },
      ])
    }
  })
}, 30_000)

test("background acknowledgement finishes while the process stays alive; late output never enters history", async () => {
  await fixture(async ({ execute, root, child, shell, sessions, jobs, directory }) => {
    const result = await execute(root.id, {
      command: "while [ ! -e release ]; do sleep 0.01; done; printf late-result",
      background: true,
    })
    const [running] = await Effect.runPromise(shell.list())
    expect(result.metadata).toMatchObject({ status: "running", shellID: running.id })
    expect(running.status).toBe("running")
    expect((await Effect.runPromise(sessions.active)).has(root.id)).toBe(false)
    await Effect.runPromise(closeShellTurn(root.id, Effect.succeed(false)))
    expect((await Effect.runPromise(shell.get(running.id))).status).toBe("running")
    await writeFile(path.join(directory, "release"), "")
    await drainNotification(jobs, running.id)
    expect(await Effect.runPromise(sessions.inbox(root.id))).toEqual([])
    expect(await Effect.runPromise(sessions.messages({ sessionID: root.id }))).toEqual([])

    // A reply/next turn opens a new generation on the same session; old shells still cannot wake it.
    await Effect.runPromise(openShellTurn(root.id))
    const next = await execute(child.id, {
      command: "while [ ! -e release-next ]; do sleep 0.01; done; printf after-vote",
      background: true,
    })
    const [old] = await Effect.runPromise(shell.list())
    expect(next.metadata).toMatchObject({ shellID: old.id })
    await Effect.runPromise(closeShellTurn(root.id, Effect.succeed(false)))
    await Effect.runPromise(openShellTurn(root.id))
    await writeFile(path.join(directory, "release-next"), "")
    await drainNotification(jobs, old.id)
    expect(await Effect.runPromise(sessions.inbox(root.id))).toEqual([])
    expect(await Effect.runPromise(sessions.messages({ sessionID: root.id }))).toEqual([])
    expect(await Effect.runPromise(sessions.inbox(child.id))).toEqual([])
    expect(await Effect.runPromise(sessions.messages({ sessionID: child.id }))).toEqual([])
  })
}, 30_000)

test("Stop/release cancels root and child shell jobs without killing another session's shell", async () => {
  await fixture(async ({ execute, root, child, other, shell, jobs, sessions }) => {
    for (const info of [root, child, other]) await execute(info.id, { command: "sleep 60", background: true })
    const before = await Effect.runPromise(shell.list())
    expect(before).toHaveLength(3)
    await Effect.runPromise(closeShellTurn(root.id, Effect.succeed(false)))
    for (const info of [root, child])
      await Effect.runPromise(
        cancelSessionShells(info.id).pipe(
          Effect.provideService(Shell.Service, shell),
          Effect.provideService(Job.Service, jobs),
        ),
      )
    expect((await Effect.runPromise(shell.list())).map((info) => info.metadata.sessionID)).toEqual([other.id])
    for (const stopped of before.filter((info) => info.metadata.sessionID !== other.id)) {
      expect(await Effect.runPromiseExit(shell.get(stopped.id))).toMatchObject({ _tag: "Failure" })
      expect(await Effect.runPromise(jobs.get(stopped.id))).toBeUndefined()
      await expectProcessGroupEnded(stopped.pid)
    }
    expect(await Effect.runPromise(sessions.inbox(root.id))).toEqual([])
    expect(await Effect.runPromise(sessions.inbox(child.id))).toEqual([])
    await Effect.runPromise(
      cancelSessionShells(other.id).pipe(
        Effect.provideService(Shell.Service, shell),
        Effect.provideService(Job.Service, jobs),
      ),
    )
    expect(await Effect.runPromise(shell.list())).toEqual([])
  })
}, 30_000)

test("existing environment disposal ends a retained background shell, including one with no listener", async () => {
  await fixture(async ({ execute, root, shell, dispose }) => {
    await execute(root.id, { command: "sleep 60", background: true })
    const [running] = await Effect.runPromise(shell.list())
    await Effect.runPromise(closeShellTurn(root.id, Effect.succeed(false)))
    expect((await Effect.runPromise(shell.get(running.id))).status).toBe("running")
    const failure = await expectProcessGroupEnded(running.pid).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: `shell process group ${running.pid} survived cleanup` })
    await dispose()
    await expectProcessGroupEnded(running.pid)
  })
}, 30_000)
