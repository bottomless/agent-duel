import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { Agent } from "@/agent/agent"
import { forkSessionInto } from "@/arena/fork"
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
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
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

const git = Effect.fn("ArenaForkTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) {
    return yield* Effect.fail(new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.text()}`))
  }
  return result.text().trim()
})

const createDetachedWorktree = Effect.fn("ArenaForkTest.createDetachedWorktree")(function* (name: string, ref: string) {
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

/** One user turn and one assistant write, every path rooted at `root`. */
const seedHistory = Effect.fn("ArenaForkTest.seedHistory")(function* (sessionID: SessionID, root: string) {
  const sessions = yield* Session.Service
  const file = path.join(root, "src", "index.ts")
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
    text: `rename the export in ${file}; leave ${root}2/notes.txt alone`,
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
    type: "tool",
    callID: "call-write",
    tool: "write",
    state: {
      status: "completed",
      input: { filePath: file, content: "export const renamed = 1\n" },
      output: `Wrote ${file}`,
      title: file,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
})

function texts(history: readonly SessionV1.WithParts[]) {
  return history.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

function toolInputs(history: readonly SessionV1.WithParts[]) {
  return history.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool" && part.state.status === "completed" ? [part.state.input] : [],
    ),
  )
}

function assistantPaths(history: readonly SessionV1.WithParts[]) {
  return history.flatMap((message) => (message.info.role === "assistant" ? [message.info.path] : []))
}

const prepareRepository = Effect.fn("ArenaForkTest.prepareRepository")(function* () {
  const root = yield* tmpdirScoped({ git: true })
  yield* Effect.promise(() => mkdir(path.join(root, "src"), { recursive: true }))
  yield* Effect.promise(() => Bun.write(path.join(root, "src", "index.ts"), "export const original = 1\n"))
  yield* git(root, ["add", "."])
  yield* git(root, ["commit", "-m", "fixture base"])
  const base = yield* git(root, ["rev-parse", "HEAD"])
  const worktree = yield* createDetachedWorktree("arena-fork", base).pipe(provideInstance(root))
  yield* Effect.addFinalizer(() =>
    Worktree.Service.use((service) => service.remove({ directory: worktree.directory })).pipe(
      provideInstance(root),
      Effect.ignore,
    ),
  )
  return { root, worktree: worktree.directory }
})

describe("Arena fork", () => {
  it.live("moves the copy and points every copied path at the destination", () =>
    Effect.gen(function* () {
      const { root, worktree } = yield* prepareRepository()
      const sessions = yield* Session.Service
      const source = yield* provideInstance(root)(sessions.create({ title: "source" }))
      yield* seedHistory(source.id, root).pipe(provideInstance(root))
      const before = yield* sessions.messages({ sessionID: source.id })

      const forked = yield* forkSessionInto({ sessionID: source.id, destination: worktree })

      expect((yield* sessions.get(forked.id)).directory).toBe(worktree)
      const copy = yield* sessions.messages({ sessionID: forked.id })
      expect(texts(copy)).toEqual([
        `rename the export in ${path.join(worktree, "src", "index.ts")}; leave ${root}2/notes.txt alone`,
      ])
      expect(toolInputs(copy)).toEqual([
        { filePath: path.join(worktree, "src", "index.ts"), content: "export const renamed = 1\n" },
      ])
      expect(assistantPaths(copy)).toEqual([{ cwd: worktree, root: worktree }])

      // The source keeps its own paths.
      expect((yield* sessions.get(source.id)).directory).toBe(root)
      expect(yield* sessions.messages({ sessionID: source.id })).toEqual(before)
    }),
  )

  it.live("keeps battle prompts and tool output while retargeting assistant paths", () =>
    Effect.gen(function* () {
      const { root, worktree } = yield* prepareRepository()
      const sessions = yield* Session.Service
      const source = yield* provideInstance(root)(sessions.create({ title: "source" }))
      yield* seedHistory(source.id, root).pipe(provideInstance(root))
      const history = yield* sessions.messages({ sessionID: source.id })
      const assistant = history.find((message) => message.info.role === "assistant")
      if (!assistant) return yield* Effect.fail(new Error("Seeded assistant message missing"))
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.info.id,
        sessionID: source.id,
        type: "text",
        text: `File: ${path.join(root, "src", "index.ts")}`,
      })

      const forked = yield* forkSessionInto({ sessionID: source.id, destination: worktree, pathMode: "transcript" })
      const copy = yield* sessions.messages({ sessionID: forked.id })
      expect(texts(copy)).toEqual([
        `rename the export in ${path.join(root, "src", "index.ts")}; leave ${root}2/notes.txt alone`,
        `File: ${path.join(worktree, "src", "index.ts")}`,
      ])
      expect(toolInputs(copy)).toEqual([
        { filePath: path.join(worktree, "src", "index.ts"), content: "export const renamed = 1\n" },
      ])
      const output = copy.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" && part.state.status === "completed" ? [part.state.output] : [],
        ),
      )
      expect(output).toEqual([`Wrote ${path.join(root, "src", "index.ts")}`])
    }),
  )

  it.live("maps a session opened in a subdirectory onto the destination's top level", () =>
    Effect.gen(function* () {
      const { root, worktree } = yield* prepareRepository()
      const subdirectory = path.join(root, "src")
      const sessions = yield* Session.Service
      const source = yield* provideInstance(subdirectory)(sessions.create({ title: "source" }))
      yield* seedHistory(source.id, root).pipe(provideInstance(subdirectory))

      const forked = yield* forkSessionInto({ sessionID: source.id, destination: worktree })

      expect((yield* sessions.get(forked.id)).directory).toBe(worktree)
      const copy = yield* sessions.messages({ sessionID: forked.id })
      expect(toolInputs(copy)).toEqual([
        { filePath: path.join(worktree, "src", "index.ts"), content: "export const renamed = 1\n" },
      ])
    }),
  )

  it.live("leaves a same-directory fork where it is", () =>
    Effect.gen(function* () {
      const { root } = yield* prepareRepository()
      const sessions = yield* Session.Service
      const source = yield* provideInstance(root)(sessions.create({ title: "source" }))
      yield* seedHistory(source.id, root).pipe(provideInstance(root))
      const before = yield* sessions.messages({ sessionID: source.id })

      const forked = yield* forkSessionInto({ sessionID: source.id, destination: root })

      expect((yield* sessions.get(forked.id)).directory).toBe(root)
      const copy = yield* sessions.messages({ sessionID: forked.id })
      expect(texts(copy)).toEqual(texts(before))
      expect(toolInputs(copy)).toEqual(toolInputs(before))
    }),
  )
})
