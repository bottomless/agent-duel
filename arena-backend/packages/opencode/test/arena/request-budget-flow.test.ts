import { expect } from "bun:test"
import { MockLanguageModelV3 } from "ai/test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionSummary } from "@/session/summary"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { Token } from "@/util/token"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageID, PartID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
for (const scenario of [
  {
    name: "lets the control plane compact a step it can summarize",
    provider: "arena",
    compact: true,
    auto: true,
    header: "auto",
  },
  { name: "sends no compaction offer for a request nothing can shrink", provider: "arena", compact: false, auto: true },
  { name: "sends no compaction offer when automatic compaction is off", provider: "arena", compact: true, auto: false },
  { name: "leaves non-Arena requests unchanged", provider: "test", compact: true, auto: true },
] as const) {
  const headers: (Record<string, string | undefined> | undefined)[] = []
  const language = new MockLanguageModelV3({
    doStream: async (request) => {
      headers.push(request.headers)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" })
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "Done." })
            controller.enqueue({ type: "text-end", id: "text-1" })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            })
            controller.close()
          },
        }),
      }
    },
  })
  const model = ProviderTest.model({
    providerID: ProviderV2.ID.make(scenario.provider),
    id: ModelV2.ID.make("contestant"),
    limit: { context: 500_000, output: 32_000 },
  })
  const provider = ProviderTest.fake({ model, getLanguage: () => Effect.succeed(language) })
  const env = LayerNode.compile(
    LayerNode.group([SessionProcessor.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]),
    [
      [Provider.node, provider.layer],
      [SessionSummary.node, summary],
    ],
  )
  const it = testEffect(env)
  it.live(
    scenario.name,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const processors = yield* SessionProcessor.Service
          const session = yield* sessions.create({})
          const user: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
          }
          yield* sessions.updateMessage(user)
          const assistant: SessionV1.Assistant = {
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            time: { created: Date.now() },
            agent: "build",
            mode: "build",
            modelID: model.id,
            providerID: model.providerID,
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          yield* sessions.updateMessage(assistant)
          const handle = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
          // The engine no longer measures the request itself: a large one goes out, and the
          // control plane answers with the compaction signal when the hidden model needs it.
          const result = yield* handle.process({
            user,
            sessionID: session.id,
            model,
            agent: { name: "build", mode: "primary", prompt: "s".repeat(8_000 * 4), options: {}, permission: [] },
            system: ["s".repeat(8_000 * 4)],
            messages: [{ role: "user", content: "x".repeat(300_000 * 4) }],
            tools: {},
            arenaRequestCompaction: scenario.compact,
          })
          expect(result).toBe("continue")
          expect(headers).toHaveLength(1)
          expect(headers[0]?.["x-arena-compaction"]).toBe("header" in scenario ? scenario.header : undefined)
          expect(handle.message.error).toBeUndefined()
        }),
      { config: { compaction: { auto: scenario.auto } } },
    ),
  )
}

const summaryRequests: number[] = []
const summaryHeaders: (string | undefined)[] = []
const summaryLanguage = new MockLanguageModelV3({
  doStream: async (request) => {
    summaryRequests.push(Token.estimate(JSON.stringify(request.prompt)))
    summaryHeaders.push(request.headers?.["x-arena-compaction"])
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "summary" })
          controller.enqueue({
            type: "text-delta",
            id: "summary",
            delta: "Continue the user's task using the new paste.",
          })
          controller.enqueue({ type: "text-end", id: "summary" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: { inputTokens: { total: 310_000 }, outputTokens: { total: 12 } },
          })
          controller.close()
        },
      }),
    }
  },
})
const summaryModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("arena"),
  id: ModelV2.ID.make("contestant"),
  limit: { context: 500_000, output: 32_000 },
})
const summaryProvider = ProviderTest.fake({ model: summaryModel, getLanguage: () => Effect.succeed(summaryLanguage) })
const compactionEnv = LayerNode.compile(
  LayerNode.group([SessionCompaction.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]),
  [
    [Provider.node, summaryProvider.layer],
    [SessionSummary.node, summary],
  ],
)
const compactionTest = testEffect(compactionEnv)
compactionTest.live(
  "sends a summary above 272k when a large paste is added to a long conversation",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const session = yield* sessions.create({})
      for (const text of ["h".repeat(230_000 * 4), "p".repeat(80_000 * 4)]) {
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: summaryModel.providerID, modelID: summaryModel.id },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text,
        })
      }
      yield* compaction.create({
        sessionID: session.id,
        agent: "build",
        model: { providerID: summaryModel.providerID, modelID: summaryModel.id },
        auto: true,
      })
      const messages = yield* sessions.messages({ sessionID: session.id })
      const parent = messages.at(-1)
      if (!parent) throw new Error("Missing compaction marker")
      const result = yield* compaction.process({
        parentID: parent.info.id,
        messages,
        sessionID: session.id,
        auto: true,
      })
      expect(result).toBe("continue")
      expect(summaryRequests).toHaveLength(1)
      expect(summaryRequests[0]).toBeGreaterThan(272_000)
      // A summary may pass the savings level; only the model's window can refuse it.
      expect(summaryHeaders).toEqual([undefined])
      const updated = yield* sessions.messages({ sessionID: session.id })
      const generated = updated.find((message) => message.info.role === "assistant" && message.info.summary)
      expect(generated?.info).toMatchObject({ finish: "stop", summary: true })
      expect(updated.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", synthetic: true }))
    }),
  ),
)

for (const historyTokens of [230_000, 300_000]) {
  const requests: string[] = []
  const language = new MockLanguageModelV3({
    doStream: async (request) => {
      requests.push(JSON.stringify(request.prompt))
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "summary" })
            controller.enqueue({
              type: "text-delta",
              id: "summary",
              delta: "Earlier task completed. Use the retained new request next.",
            })
            controller.enqueue({ type: "text-end", id: "summary" })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: { inputTokens: { total: historyTokens }, outputTokens: { total: 16 } },
            })
            controller.close()
          },
        }),
      }
    },
  })
  const attachmentModel = {
    ...summaryModel,
    capabilities: {
      ...summaryModel.capabilities,
      attachment: true,
      input: { ...summaryModel.capabilities.input, image: true, pdf: true },
    },
  }
  const provider = ProviderTest.fake({ model: attachmentModel, getLanguage: () => Effect.succeed(language) })
  const env = LayerNode.compile(
    LayerNode.group([SessionCompaction.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]),
    [
      [Provider.node, provider.layer],
      [SessionSummary.node, summary],
    ],
  )
  testEffect(env).live(
    `preserves a new 80k paste and attachments when compacting ${historyTokens} tokens of earlier history`,
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const session = yield* sessions.create({})
        const old = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: summaryModel.providerID, modelID: summaryModel.id },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: old.id,
          type: "text",
          text: "OLD_HISTORY_" + "h".repeat(historyTokens * 4),
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: old.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          agent: "build",
          mode: "build",
          modelID: summaryModel.id,
          providerID: summaryModel.providerID,
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        const fresh = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: summaryModel.providerID, modelID: summaryModel.id },
          system: "Keep the exact new input.",
          tools: { bash: false },
          format: new SessionV1.OutputFormatJsonSchema({
            type: "json_schema",
            schema: { type: "object" },
            retryCount: 0,
          }),
        })
        const paste = "FRESH_PASTE_" + "p".repeat(80_000 * 4)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: fresh.id,
          type: "text",
          text: paste,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: fresh.id,
          type: "file",
          mime: "image/png",
          filename: "fresh.png",
          url: "data:image/png;base64,aGVsbG8=",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: fresh.id,
          type: "file",
          mime: "application/pdf",
          filename: "fresh.pdf",
          url: "data:application/pdf;base64,cGRm",
        })
        const before = yield* sessions.messages({ sessionID: session.id })
        yield* compaction.create({ sessionID: session.id, agent: "build", model: fresh.model, auto: true })
        const messages = yield* sessions.messages({ sessionID: session.id })
        const result = yield* compaction.process({
          parentID: messages.at(-1)!.info.id,
          messages,
          sessionID: session.id,
          auto: true,
        })
        expect(result).toBe("continue")
        expect(requests).toHaveLength(1)
        expect(requests[0]).toContain("OLD_HISTORY_")
        expect(requests[0]).not.toContain("FRESH_PASTE_")
        expect(requests[0]).not.toContain("fresh.png")
        expect(requests[0]).not.toContain("fresh.pdf")
        const updated = yield* sessions.messages({ sessionID: session.id })
        const retained = MessageV2.filterCompacted([...updated].reverse())
        expect(retained.find((m) => m.info.id === fresh.id)).toEqual(before.find((m) => m.info.id === fresh.id))
        const continuation = MessageV2.latest(retained).user!
        expect(continuation).toMatchObject({ system: fresh.system, tools: fresh.tools, format: { ...fresh.format } })
        const converted = JSON.stringify(yield* MessageV2.toModelMessagesEffect(retained, attachmentModel))
        expect(converted).toContain(paste)
        expect(converted).toContain("aGVsbG8=")
        expect(converted).toContain("cGRm")
        expect(converted).not.toContain("OLD_HISTORY_")
      }),
    ),
  )
}
