import { afterEach, describe, expect } from "bun:test"
import { APICallError } from "ai"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionCompaction } from "@/session/compaction"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { LLM } from "@/session/llm"
import { SessionSummary } from "@/session/summary"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { MessageID, PartID } from "@/session/schema"
import { ArenaRuntime } from "@/arena/runtime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelIdleError } from "@/arena/model-idle"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { LLMEvent, Usage } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const config = Layer.succeed(
  Config.Service,
  TestConfig.make({ get: () => Effect.succeed({ compaction: { tail_turns: 0 } }) }),
)

const model = ProviderTest.model({
  id: ModelV2.ID.make("contestant"),
  providerID: ProviderV2.ID.make(ArenaRuntime.providerID),
  limit: { context: 500_000, output: 32_000 },
})

const usage = new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

function reply(text: string) {
  return Stream.make(
    LLMEvent.textStart({ id: "summary" }),
    LLMEvent.textDelta({ id: "summary", text }),
    LLMEvent.textEnd({ id: "summary" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
    LLMEvent.finish({ reason: "stop", usage }),
  )
}

function rejection() {
  return Stream.fail(
    new APICallError({
      message: "Arena request needs compaction",
      url: "https://arena.invalid/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 413,
      responseBody: JSON.stringify({ error: { type: "arena_compaction_required" } }),
      isRetryable: false,
    }),
  )
}

function providerFailure() {
  return Stream.fail(
    new APICallError({
      message: "payment required",
      url: "https://arena.invalid/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: { code: "arena_payment_required" } }),
      isRetryable: false,
    }),
  )
}

type StreamInput = Parameters<LLM.Interface["stream"]>[0]
type QueuedStream = Stream.Stream<LLMEvent, unknown> | ((input: StreamInput) => Stream.Stream<LLMEvent, unknown>)
const seen: string[] = []
const queue: QueuedStream[] = []
const llm = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const next = queue.shift() ?? reply("unexpected")
      return (typeof next === "function" ? next(input) : next).pipe(Stream.mapEffect(Effect.succeed))
    },
  }),
)
const env = AppNodeBuilder.build(
  LayerNode.group([
    SessionCompaction.node,
    SessionProcessor.node,
    Session.node,
    SessionProjector.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [Provider.node, ProviderTest.fake({ model }).layer],
    [LLM.node, llm],
    [SessionSummary.node, summary],
    [Config.node, config],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ],
)
const it = testEffect(env)

afterEach(() => {
  queue.length = 0
  seen.length = 0
  ArenaRuntime.registry.assignments.clear()
})

const seed = (texts: string[]) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    ArenaRuntime.registry.assign(session.id, {
      runID: "run-a",
      rootSessionID: session.id,
      scopeID: "scope-a",
      assignmentID: "assignment-a",
      telemetry: true,
    })
    for (const text of texts) {
      const user: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: user.id,
        type: "text",
        text,
      })
    }
    const marker: SessionV1.User = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    }
    yield* sessions.updateMessage(marker)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: marker.id,
      type: "compaction",
      auto: false,
    })
    return { session, marker }
  })

describe("Arena adaptive compaction", () => {
  it.live(
    "splits a rejected transcript and commits only the completed rolling summary",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seen.length = 0
        queue.push(
          rejection(),
          rejection(),
          (input: StreamInput) => {
            seen.push(JSON.stringify(input.messages))
            return reply("first rolling summary")
          },
          (input: StreamInput) => {
            seen.push(JSON.stringify(input.messages))
            return reply("final rolling summary")
          },
        )
        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const compaction = yield* SessionCompaction.Service
          const { session, marker } = yield* seed(["source-a", "source-b", "source-c", "source-d"])

          const result = yield* compaction.process({
            parentID: marker.id,
            messages: yield* sessions.messages({ sessionID: session.id }),
            sessionID: session.id,
            auto: false,
          })
          const messages = yield* sessions.messages({ sessionID: session.id })
          const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
          expect(result).toBe("continue")
          expect(summaries).toHaveLength(1)
          expect(
            summaries[0]?.parts.some((part) => part.type === "text" && part.text === "final rolling summary"),
          ).toBe(true)
          expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
          expect(seen.join("\n")).toContain("source-a")
          expect(seen.join("\n")).toContain("source-b")
          expect(seen.join("\n")).toContain("source-c")
          expect(seen.join("\n")).toContain("source-d")
        })
      }),
    ),
  )

  it.live(
    "serializes and splits one giant source message without dropping its text",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seen.length = 0
        queue.push(
          rejection(),
          rejection(),
          (input: StreamInput) => {
            seen.push(JSON.stringify(input.messages))
            return reply("first giant summary")
          },
          (input: StreamInput) => {
            seen.push(JSON.stringify(input.messages))
            return reply("final giant summary")
          },
        )
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const source = `source-start-${"x".repeat(12_000)}-source-end`
        const { session, marker } = yield* seed([source])
        const result = yield* compaction.process({
          parentID: marker.id,
          messages: yield* sessions.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(result).toBe("continue")
        expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
        expect(seen.join("\n")).toContain("source-start-")
        expect(seen.join("\n")).toContain("source-end")
      }),
    ),
  )

  it.live(
    "keeps source history visible when a rolling batch exhausts recovery",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seen.length = 0
        queue.push(
          rejection(),
          rejection(),
          Stream.fail(new ModelIdleError(150_000)),
          Stream.fail(new ModelIdleError(150_000)),
          Stream.fail(new ModelIdleError(150_000)),
          Stream.fail(new ModelIdleError(150_000)),
        )
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const { session, marker } = yield* seed(["source-a", "source-b"])
        const before = yield* sessions.messages({ sessionID: session.id })
        const result = yield* compaction.process({
          parentID: marker.id,
          messages: before,
          sessionID: session.id,
          auto: false,
        })
        const after = yield* sessions.messages({ sessionID: session.id })
        expect(result).toBe("stop")
        expect(after.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
        const visible = MessageV2.filterCompacted(after.toReversed()).map((message) => message.info.id)
        for (const message of before) expect(visible).toContain(message.info.id)
      }),
    ),
  )

  it.live(
    "preserves a provider error when a rolling batch stops",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        queue.push(rejection(), rejection(), providerFailure())
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const { session, marker } = yield* seed(["source-a", "source-b"])
        const result = yield* compaction.process({
          parentID: marker.id,
          messages: yield* sessions.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        const messages = yield* sessions.messages({ sessionID: session.id })
        const failed = messages.find((message) => message.info.role === "assistant")
        expect(result).toBe("stop")
        expect(failed?.info.role === "assistant" ? failed.info.error : undefined).toMatchObject({
          data: { isRetryable: false },
        })
        expect(failed?.info.role === "assistant" ? failed.info.error?.data.statusCode : undefined).toBe(402)
      }),
    ),
  )

  it.live(
    "keeps the ordinary Arena one-shot summary path unchanged",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        queue.push((input: StreamInput) => {
          seen.push(JSON.stringify(input.messages))
          return reply("one-shot summary")
        })
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const { session, marker } = yield* seed(["source-a"])
        const result = yield* compaction.process({
          parentID: marker.id,
          messages: yield* sessions.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        const messages = yield* sessions.messages({ sessionID: session.id })
        const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
        expect(result).toBe("continue")
        expect(summaries).toHaveLength(1)
        expect(summaries[0]?.parts.some((part) => part.type === "text" && part.text === "one-shot summary")).toBe(true)
        expect(seen).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "stops safely when every transcript segment is refused by the hosted context envelope",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        for (let index = 0; index < 70; index++) queue.push(rejection())
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const { session, marker } = yield* seed(["source-a", "source-b"])
        const before = yield* sessions.messages({ sessionID: session.id })
        const result = yield* compaction.process({
          parentID: marker.id,
          messages: before,
          sessionID: session.id,
          auto: false,
        })
        const after = yield* sessions.messages({ sessionID: session.id })
        const visible = MessageV2.filterCompacted(after.toReversed()).map((message) => message.info.id)
        const failed = after.find((message) => message.info.role === "assistant")
        expect(result).toBe("stop")
        expect(after.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
        expect(failed?.info.role === "assistant" ? failed.info.error?.data.message : undefined).toContain(
          "bounded batches",
        )
        for (const message of before) expect(visible).toContain(message.info.id)
      }),
    ),
  )
})
