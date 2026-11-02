import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Layer, Schema, Stream, type Scope } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { Session as CoreSession } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ArenaService } from "@/arena/service"
import { connectLocalStore } from "@/arena/local-store"
import { battleMetricsSchemaVersion, type ChatDocument, type TurnDocument } from "@/arena/records"
import { recoverOnce, setStoreForTest } from "@/arena/runtime"
import {
  Session,
  SessionPrompt,
  SessionStatus,
  Permission,
  Question,
  MoveSessionService,
  sessionNode,
  locationServiceMapNode,
} from "@/arena/session-runtime"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { globalProjectNode } from "../../../core/test/lib/project"
import { promptLocationNode } from "../../../core/test/fixture/prompt-location"
import { offlineModels } from "../../../core/test/fixture/models"

// No V2 Arena bridge is installed: the real projector commits the rewind without notifying Arena.
const coreLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, CoreSession.node, sessionNode]),
  [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    locationServiceMapNode.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    offlineModels,
  ],
)
// The legacy testEffect fixture imports unavailable @opencode-ai/core modules on this branch.
const it = {
  live: <A, E>(name: string, body: () => Effect.Effect<A, E, Layer.Success<typeof coreLayer> | Scope.Scope>) =>
    test(name, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(coreLayer)
          return yield* body().pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      ),
    ),
}
const now = new Date("2026-11-02T00:00:00Z")
const assignment = {
  assignmentID: "assignment",
  model: "Contestant",
  requestedReasoning: {},
  enforcedReasoning: {},
}

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "arena-rewind-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const store = yield* Effect.acquireRelease(
    Effect.promise(() => connectLocalStore({ directory })),
    (store) => Effect.promise(() => store.close()),
  )
  const previous = process.env.OPENCODE_ARENA
  process.env.OPENCODE_ARENA = "1"
  setStoreForTest(store)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      setStoreForTest(undefined)
      if (previous === undefined) delete process.env.OPENCODE_ARENA
      else process.env.OPENCODE_ARENA = previous
    }),
  )
  const native = yield* Session
  const core = yield* CoreSession.Service
  const canonical = yield* core.create({ location: Location.Ref.make({ directory: AbsolutePath.make(directory) }) })
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const chat: ChatDocument = {
    _id: "chat",
    repository: { projectID: "project", root: directory },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: canonical.id,
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 3,
    status: "ready",
    // No checkout or environments are needed to read a saved chat's summaries.
    checkoutEvicted: true,
    agentDuelCommit: "commit",
    agentDuelBuildNumber: 0,
    opencodeVersion: "version",
    agentDuelVersion: "0.4.0-beta.13",
    configuration: {
      modelPool: "hash",
      agent: "hash",
      plugins: "hash",
      mcp: "hash",
      skills: "hash",
      tools: "hash",
      system: "hash",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
  const messages = [0, 1, 2].map(
    (index): SessionMessage.User => ({
      id: SessionMessage.ID.make(`msg_rewind_${index}`),
      type: "user",
      text: `prompt ${index}`,
      time: { created: DateTime.makeUnsafe(now.getTime() + index) },
    }),
  )
  yield* Effect.promise(() => store.createChat(chat))
  for (const [index, message] of messages.entries()) {
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
    yield* database.db
      .insert(SessionMessageTable)
      .values({
        id,
        type,
        data,
        session_id: canonical.id,
        seq: index,
        time_created: now.getTime(),
        time_updated: now.getTime(),
      })
      .run()
    const turn: TurnDocument = {
      _id: `turn-${index}`,
      chatID: chat._id,
      turnIndex: index,
      userPrompt: message.text,
      frozenBaseSHA: "base",
      sourceCanonicalSessionID: canonical.id,
      canonicalTranscriptHash: "hash",
      canonicalUserMessageID: String(message.id),
      canonicalGraftedAt: now,
      pair: ["hidden/a", "hidden/b"],
      placement: { a: assignment, b: { ...assignment, assignmentID: "assignment-b" } },
      runIDs: { a: `run-${index}-a`, b: `run-${index}-b` },
      state: "complete",
      resolution: { kind: "vote", vote: "a", appliedSide: "a" },
      vote: "a",
      transitionTimestamps: { complete: now },
      comparisonState: "skipped",
      createdAt: now,
      updatedAt: now,
    }
    yield* Effect.promise(() => store.createTurn(turn))
    yield* Effect.promise(() =>
      store.battleMetrics.insertOne({
        _id: turn._id,
        turnID: turn._id,
        chatID: chat._id,
        turnIndex: index,
        schemaVersion: battleMetricsSchemaVersion,
        computedAt: now,
        modelPair: ["Contestant"],
        vote: "a",
        resolutionKind: "vote",
        selectedEarly: false,
        steerCount: 0,
        sides: {},
      }),
    )
  }
  const reads = { fail: false, count: 0 }
  const serviceLayer = ArenaService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Session, {
          canonicalMessages: (id) =>
            Effect.suspend(() => {
              reads.count++
              return reads.fail ? Effect.fail(new Error("canonical read failed")) : native.canonicalMessages(id)
            }),
          messages: native.messages,
        }),
        Layer.mock(Config.Service, {}),
        Layer.mock(InstanceStore.Service, {}),
        Layer.mock(Git.Service, {
          run: () =>
            Effect.succeed({
              exitCode: 0,
              text: () => "",
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              truncated: false,
            }),
        }),
        Layer.mock(SessionPrompt, {}),
        Layer.mock(Image.Service, {}),
        Layer.mock(SessionStatus, {}),
        Layer.mock(Permission, {}),
        Layer.mock(Question, {}),
        Layer.mock(Worktree.Service, {}),
        Layer.mock(MoveSessionService, {}),
      ),
    ),
  )
  const open = Effect.gen(function* () {
    const context = yield* Layer.build(serviceLayer)
    return yield* ArenaService.Service.pipe(Effect.provide(context))
  })
  const rewind = (index: number) =>
    bus.publish(SessionEvent.RevertEvent.Committed, {
      sessionID: canonical.id,
      to: messages[index]!.id,
    })
  return { store, directory, chat, canonical, messages, reads, open, rewind }
})

it.live("a missed native rewind is reconciled on chat load and stays hidden after a new service opens", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    // The first service is already running when the live notification is missed.
    yield* Effect.promise(() => recoverOnce(async () => {}))
    const arena = yield* f.open
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0", "turn-1", "turn-2"])
    const metrics = yield* Effect.promise(() => f.store.battleMetrics.find({}).toArray())
    yield* f.rewind(1)
    expect((yield* (yield* Session).canonicalMessages(f.canonical.id)).map((message) => message.id)).toEqual([
      f.messages[0]!.id,
    ])
    expect((yield* Effect.promise(() => f.store.snapshot(f.chat._id))).history?.map((turn) => turn._id)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ])

    const loaded = yield* arena.session(f.canonical.id)
    expect(loaded.history.map((turn) => turn.id)).toEqual(["turn-0"])
    expect(loaded.turn?.id).toBe("turn-0")
    const marked = yield* Effect.promise(() => f.store.turn("turn-1"))
    expect(marked?.rewoundAt).toBeInstanceOf(Date)
    expect(marked?.resolution).toEqual({ kind: "vote", vote: "a", appliedSide: "a" })
    expect((yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))).map((turn) => turn._id)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ])
    expect(yield* Effect.promise(() => f.store.battleMetrics.find({}).toArray())).toEqual(metrics)
    expect((yield* Effect.promise(() => f.store.turn("turn-0")))?.rewoundAt).toBeUndefined()

    const reopened = yield* Effect.acquireRelease(
      Effect.promise(() => connectLocalStore({ directory: f.directory })),
      (store) => Effect.promise(() => store.close()),
    )
    setStoreForTest(reopened)
    const restarted = yield* f.open
    expect((yield* restarted.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0"])
    expect((yield* Effect.promise(() => reopened.turn("turn-1")))?.rewoundAt).toEqual(marked?.rewoundAt)
    expect(yield* Effect.promise(() => reopened.battleMetrics.find({}).toArray())).toEqual(metrics)
  }),
)

it.live("startup repairs an unopened chat after a missed native rewind", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.rewind(1)
    const other = yield* (yield* CoreSession.Service).create({
      location: Location.Ref.make({ directory: AbsolutePath.make(f.directory) }),
    })
    yield* Effect.promise(() => f.store.createChat({ ...f.chat, _id: "other", canonicalSessionID: other.id }))
    const arena = yield* f.open
    expect((yield* arena.snapshot("other")).history).toEqual([])
    // This chat was never requested; startup must repair it before serving the other one.
    expect((yield* Effect.promise(() => f.store.snapshot(f.chat._id))).history?.map((turn) => turn._id)).toEqual([
      "turn-0",
    ])
    expect((yield* Effect.promise(() => f.store.turn("turn-1")))?.rewoundAt).toBeInstanceOf(Date)
    expect((yield* Effect.promise(() => f.store.turn("turn-2")))?.rewoundAt).toBeInstanceOf(Date)
    expect((yield* Effect.promise(() => f.store.turn("turn-0")))?.rewoundAt).toBeUndefined()
  }),
)

it.live("a failed canonical read marks nothing and a later snapshot repairs the missed rewind idempotently", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.rewind(1)
    f.reads.fail = true
    const arena = yield* f.open
    const before = yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0", "turn-1", "turn-2"])
    expect(yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))).toEqual(before)
    expect(f.reads.count).toBeGreaterThan(0)

    f.reads.fail = false
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0"])
    const repaired = yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0"])
    expect(yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))).toEqual(repaired)
  }),
)

it.live("an active graft cannot hide a surviving turn while its canonical prompt is temporarily absent", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.promise(() => recoverOnce(async () => {}))
    const arena = yield* f.open
    yield* Effect.promise(() =>
      f.store.updateChat({ _id: f.chat._id }, { $set: { status: "battle_active", activeTurnID: "turn-2" } }),
    )
    yield* Effect.promise(() => f.store.updateTurn("turn-2", { state: "canonicalizing" }))
    yield* f.rewind(1)
    yield* arena.recordRevert(f.canonical.id)
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0", "turn-1", "turn-2"])
    expect(f.reads.count).toBe(0)
    expect((yield* Effect.promise(() => f.store.turn("turn-2")))?.rewoundAt).toBeUndefined()

    // The winner's graft restores its own prompt after removing a partial copy.
    const database = yield* Database.Service
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(f.messages[2]!)
    yield* database.db
      .insert(SessionMessageTable)
      .values({
        id,
        type,
        data,
        session_id: f.canonical.id,
        seq: 1,
        time_created: now.getTime(),
        time_updated: now.getTime(),
      })
      .run()
    yield* Effect.promise(() => f.store.updateTurn("turn-2", { state: "complete" }))
    yield* Effect.promise(() =>
      f.store.updateChat({ _id: f.chat._id }, { $set: { status: "ready" }, $unset: { activeTurnID: "" } }),
    )
    expect((yield* arena.snapshot(f.chat._id)).history.map((turn) => turn.id)).toEqual(["turn-0", "turn-2"])
    expect((yield* Effect.promise(() => f.store.turn("turn-2")))?.rewoundAt).toBeUndefined()
  }),
)

it.live("opening a stream repairs a missed rewind before its first snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.promise(() => recoverOnce(async () => {}))
    const arena = yield* f.open
    yield* f.rewind(1)
    const stream = yield* arena.stream(f.canonical.id)
    const frames = yield* Stream.runCollect(stream.pipe(Stream.take(1)))
    const first = frames[0]
    expect(first?.kind).toBe("snapshot")
    if (first?.kind !== "snapshot") throw new Error("initial snapshot missing")
    expect(first.snapshot.history.map((turn) => turn.id)).toEqual(["turn-0"])
  }),
)

it.live("the live rewind callback still marks removed turns and invalidates cached history", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.promise(() => recoverOnce(async () => {}))
    const arena = yield* f.open
    let changes = 0
    const off = f.store.onChange(() => changes++, f.chat._id)
    yield* Effect.addFinalizer(() => Effect.sync(off))
    expect((yield* Effect.promise(() => f.store.snapshot(f.chat._id))).history).toHaveLength(3)
    yield* f.rewind(1)
    yield* arena.recordRevert(f.canonical.id)
    expect((yield* Effect.promise(() => f.store.snapshot(f.chat._id))).history?.map((turn) => turn._id)).toEqual([
      "turn-0",
    ])
    expect(changes).toBeGreaterThan(0)
    const marked = yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))
    const after = changes
    yield* arena.recordRevert(f.canonical.id)
    expect(changes).toBe(after)
    expect(yield* Effect.promise(() => f.store.turnsForChat(f.chat._id))).toEqual(marked)
  }),
)
