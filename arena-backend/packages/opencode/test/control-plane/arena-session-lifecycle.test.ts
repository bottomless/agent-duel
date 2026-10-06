import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Format } from "@/format"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { Worktree } from "@/worktree"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Session.node,
    SessionPrompt.node,
    SessionProjector.node,
    MoveSession.node,
    Worktree.node,
    InstanceStore.node,
    Project.node,
    ProjectDirectories.node,
    Agent.node,
    LSP.node,
    FSUtil.node,
    EventV2Bridge.node,
    Format.node,
    Git.node,
    Truncate.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ],
)

const it = testEffect(layer)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const git = Effect.fn("ArenaSessionLifecycleTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString("utf8").trim() || result.text()}`),
    )
  }
  return result.text().trim()
})

const createDetachedWorktree = Effect.fn("ArenaSessionLifecycleTest.createDetachedWorktree")(function* (
  name: string,
  ref: string,
) {
  const worktrees = yield* Worktree.Service
  const ready = yield* Deferred.make<void>()
  const listener = (event: GlobalEvent) => {
    if (event.payload.type !== Worktree.Event.Ready.type) return
    if (event.payload.properties.name !== name) return
    Deferred.doneUnsafe(ready, Effect.void)
  }
  GlobalBus.on("event", listener)
  const info = yield* worktrees.makeWorktreeInfo({ name, detached: true })
  yield* worktrees.createFromInfoAt(info, ref)
  yield* awaitWithTimeout(Deferred.await(ready), `worktree ${name} never became ready`, "10 seconds").pipe(
    Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listener))),
  )
  return info
})

const seedHistory = Effect.fn("ArenaSessionLifecycleTest.seedHistory")(function* (sessionID: SessionID, root: string) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: ref,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text: "prepare the arena fixture",
  })

  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID,
    parentID: user.id,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    finish: "stop",
    time: { created: Date.now(), completed: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "fixture ready",
  })
})

const writeTurn = Effect.fn("ArenaSessionLifecycleTest.writeTurn")(function* (input: {
  sessionID: SessionID
  directory: string
  prompt: string
  file: string
  content: string
}) {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const admitted = yield* prompt.prompt({
    sessionID: input.sessionID,
    agent: "build",
    model: ref,
    noReply: true,
    parts: [{ type: "text", text: input.prompt }],
  })
  if (admitted.info.role !== "user") return yield* Effect.die("SessionPrompt returned a non-user message")
  const user = admitted.info

  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    parentID: user.id,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)

  const writeInfo = yield* WriteTool
  const write = yield* writeInfo.init()
  const started = Date.now()
  const result = yield* write.execute(
    { filePath: path.join(input.directory, input.file), content: input.content },
    {
      sessionID: input.sessionID,
      messageID: assistant.id,
      callID: `call-${input.file}`,
      agent: "build",
      abort: new AbortController().signal,
      messages: yield* sessions.messages({ sessionID: input.sessionID }),
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: `call-${input.file}`,
    tool: "write",
    state: {
      status: "completed",
      input: { filePath: path.join(input.directory, input.file), content: input.content },
      output: result.output,
      title: result.title,
      metadata: result.metadata,
      time: { start: started, end: Date.now() },
    },
  })
  yield* sessions.updateMessage({
    ...assistant,
    finish: "stop",
    time: { ...assistant.time, completed: Date.now() },
  })
})

describe("Arena V1 session lifecycle", () => {
  it.live(
    "forks into linked worktrees, promotes the winner, removes both worktrees, and continues canonically",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(root, "base.txt"), "base\n"))
        yield* git(root, ["add", "base.txt"])
        yield* git(root, ["commit", "-m", "fixture base"])
        const base = yield* git(root, ["rev-parse", "HEAD"])

        const worktreeA = yield* createDetachedWorktree("arena-lifecycle-a", base).pipe(provideInstance(root))
        yield* Effect.addFinalizer(() =>
          Worktree.Service.use((service) => service.remove({ directory: worktreeA.directory })).pipe(
            provideInstance(root),
            Effect.ignore,
          ),
        )
        const worktreeB = yield* createDetachedWorktree("arena-lifecycle-b", base).pipe(provideInstance(root))
        yield* Effect.addFinalizer(() =>
          Worktree.Service.use((service) => service.remove({ directory: worktreeB.directory })).pipe(
            provideInstance(root),
            Effect.ignore,
          ),
        )
        expect(yield* git(worktreeA.directory, ["rev-parse", "HEAD"])).toBe(base)
        expect(yield* git(worktreeB.directory, ["rev-parse", "HEAD"])).toBe(base)
        const fs = yield* FSUtil.Service
        const canonicalWorktreeA = AbsolutePath.make(yield* fs.realPath(worktreeA.directory))
        const canonicalWorktreeB = AbsolutePath.make(yield* fs.realPath(worktreeB.directory))

        const sessions = yield* Session.Service
        const canonical = yield* provideInstance(root)(sessions.create({ title: "Arena canonical" }))
        const projects = yield* Project.Service
        const directories = yield* ProjectDirectories.Service
        const registeredProject = yield* projects.get(canonical.projectID)
        const registeredDirectories = (yield* directories.list(canonical.projectID)).map((item) => item.directory)
        expect(registeredProject?.sandboxes).toContain(worktreeA.directory)
        expect(registeredProject?.sandboxes).toContain(worktreeB.directory)
        expect(registeredDirectories).toContain(canonicalWorktreeA)
        expect(registeredDirectories).toContain(canonicalWorktreeB)
        yield* seedHistory(canonical.id, root).pipe(provideInstance(root))
        const canonicalHistory = yield* sessions.messages({ sessionID: canonical.id })
        const contestantA = yield* provideInstance(root)(sessions.fork({ sessionID: canonical.id }))
        const contestantB = yield* provideInstance(root)(sessions.fork({ sessionID: canonical.id }))

        const move = yield* MoveSession.Service
        yield* move.moveSession({
          sessionID: contestantA.id,
          destination: { directory: AbsolutePath.make(worktreeA.directory) },
          moveChanges: false,
        })
        yield* move.moveSession({
          sessionID: contestantB.id,
          destination: { directory: AbsolutePath.make(worktreeB.directory) },
          moveChanges: false,
        })

        expect((yield* sessions.get(contestantA.id)).directory).toBe(worktreeA.directory)
        expect((yield* sessions.get(contestantB.id)).directory).toBe(worktreeB.directory)
        const historyA = yield* sessions.messages({ sessionID: contestantA.id })
        const historyB = yield* sessions.messages({ sessionID: contestantB.id })
        expect(historyA.map((message) => message.info.role)).toEqual(
          canonicalHistory.map((message) => message.info.role),
        )
        expect(historyB.map((message) => message.info.role)).toEqual(
          canonicalHistory.map((message) => message.info.role),
        )
        expect(historyA.map((message) => message.info.id)).not.toEqual(
          canonicalHistory.map((message) => message.info.id),
        )
        expect(historyB.map((message) => message.info.id)).not.toEqual(
          canonicalHistory.map((message) => message.info.id),
        )
        expect(
          historyA.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))),
        ).toEqual(
          canonicalHistory.flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ),
        )
        expect(
          historyB.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))),
        ).toEqual(
          canonicalHistory.flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ),
        )
        expect(historyA.map((message) => message.info.id)).not.toEqual(historyB.map((message) => message.info.id))

        yield* writeTurn({
          sessionID: contestantA.id,
          directory: worktreeA.directory,
          prompt: "write the A result",
          file: "arena-result.txt",
          content: "winner A\n",
        }).pipe(provideInstance(worktreeA.directory))
        yield* writeTurn({
          sessionID: contestantB.id,
          directory: worktreeB.directory,
          prompt: "write the B result",
          file: "arena-result.txt",
          content: "loser B\n",
        }).pipe(provideInstance(worktreeB.directory))
        expect(yield* Effect.promise(() => Bun.file(path.join(worktreeA.directory, "arena-result.txt")).text())).toBe(
          "winner A\n",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(worktreeB.directory, "arena-result.txt")).text())).toBe(
          "loser B\n",
        )

        const child = yield* provideInstance(worktreeA.directory)(
          sessions.create({ parentID: contestantA.id, title: "Arena child" }),
        )
        yield* seedHistory(child.id, worktreeA.directory).pipe(provideInstance(worktreeA.directory))

        yield* git(worktreeA.directory, ["add", "-A", "--", "."])
        yield* git(worktreeA.directory, ["commit", "-m", "arena winner"])
        const winner = yield* git(worktreeA.directory, ["rev-parse", "HEAD"])
        yield* git(root, ["merge-base", "--is-ancestor", base, winner])
        yield* git(root, ["merge", "--ff-only", winner])
        expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(winner)

        yield* move.moveSession({
          sessionID: contestantA.id,
          destination: { directory: AbsolutePath.make(root) },
          moveChanges: false,
        })
        yield* move.moveSession({
          sessionID: child.id,
          destination: { directory: AbsolutePath.make(root) },
          moveChanges: false,
        })
        expect((yield* sessions.get(contestantA.id)).directory).toBe(root)
        expect((yield* sessions.get(child.id)).directory).toBe(root)

        const worktrees = yield* Worktree.Service
        expect(yield* worktrees.remove({ directory: worktreeA.directory }).pipe(provideInstance(root))).toBe(true)
        expect(yield* worktrees.remove({ directory: worktreeB.directory }).pipe(provideInstance(root))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(worktreeA.directory).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(worktreeB.directory).exists())).toBe(false)
        const listed = yield* git(root, ["worktree", "list", "--porcelain"])
        expect(listed).not.toContain(worktreeA.directory)
        expect(listed).not.toContain(worktreeB.directory)
        const cleanedProject = yield* projects.get(canonical.projectID)
        expect(cleanedProject?.sandboxes).not.toContain(worktreeA.directory)
        expect(cleanedProject?.sandboxes).not.toContain(worktreeB.directory)
        expect(
          yield* directories.contains({
            projectID: canonical.projectID,
            directory: AbsolutePath.make(canonicalWorktreeA),
          }),
        ).toBe(false)
        expect(
          yield* directories.contains({
            projectID: canonical.projectID,
            directory: AbsolutePath.make(canonicalWorktreeB),
          }),
        ).toBe(false)

        const beforeContinuation = (yield* sessions.messages({ sessionID: contestantA.id })).length
        yield* writeTurn({
          sessionID: contestantA.id,
          directory: root,
          prompt: "continue from the winning session",
          file: "winner-follow-up.txt",
          content: "continued\n",
        }).pipe(provideInstance(root))

        expect(yield* Effect.promise(() => Bun.file(path.join(root, "arena-result.txt")).text())).toBe("winner A\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "winner-follow-up.txt")).text())).toBe(
          "continued\n",
        )
        expect((yield* sessions.messages({ sessionID: contestantA.id })).length).toBe(beforeContinuation + 2)
        expect((yield* sessions.get(child.id)).parentID).toBe(contestantA.id)
        expect((yield* sessions.messages({ sessionID: child.id })).length).toBeGreaterThan(0)
        expect((yield* sessions.messages({ sessionID: contestantB.id })).length).toBeGreaterThan(
          canonicalHistory.length,
        )
      }),
    { timeout: 30_000 },
  )
})
