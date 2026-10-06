import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import path from "node:path"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const arenaMode = process.env.OPENCODE_ARENA
afterEach(() => {
  if (arenaMode === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = arenaMode
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionSummary.node, Snapshot.node, SessionProjector.node])),
)

const changedSession = Effect.gen(function* () {
  const instance = yield* TestInstance
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const summary = yield* SessionSummary.Service
  const file = path.join(instance.directory, "changed.txt")
  yield* Effect.promise(() => Bun.write(file, "before\n"))
  const before = yield* snapshot.track()
  yield* Effect.promise(() => Bun.write(file, "after\n"))
  const after = yield* snapshot.track()
  if (!before || !after) throw new Error("Expected Git snapshots")
  expect(after).not.toBe(before)

  const session = yield* sessions.create({})
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: 1 },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    parentID: user.id,
    role: "assistant",
    agent: "build",
    mode: "build",
    providerID: ProviderV2.ID.make("test"),
    modelID: ModelV2.ID.make("test"),
    path: { cwd: instance.directory, root: instance.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2 },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "step-start",
    snapshot: before,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "step-finish",
    snapshot: after,
    reason: "tool-calls",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return { sessions, summary, sessionID: session.id, messageID: user.id }
})

it.instance(
  "Arena skips live diff summaries while preserving snapshots for explicit review",
  () =>
    Effect.gen(function* () {
      process.env.OPENCODE_ARENA = "1"
      const { sessions, summary, sessionID, messageID } = yield* changedSession
      yield* summary.summarize({ sessionID, messageID })
      expect(yield* summary.diff({ sessionID, messageID })).toEqual([])
      expect((yield* sessions.get(sessionID)).summary).toBeUndefined()

      const messages = yield* sessions.messages({ sessionID })
      const diffs = yield* summary.computeDiff({ messages })
      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({ file: "changed.txt", additions: 1, deletions: 1 })
      expect(diffs[0].patch).toContain("-before\n+after")
    }),
  { git: true },
)

it.instance(
  "ordinary OpenCode sessions retain live diff summaries",
  () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_ARENA
      const { summary, sessionID, messageID } = yield* changedSession
      yield* summary.summarize({ sessionID, messageID })
      const diffs = yield* summary.diff({ sessionID, messageID })
      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({ file: "changed.txt", additions: 1, deletions: 1 })
      expect(diffs[0].patch).toContain("-before\n+after")
    }),
  { git: true },
)
