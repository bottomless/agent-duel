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
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageID } from "@/session/schema"
import { waitForInitialDispatch } from "@/arena/dispatch"
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
    name: "requests compaction before a paid call",
    provider: "arena",
    budget: "compact",
    auto: true,
    large: true,
    result: "compact-request",
    calls: 0,
  },
  {
    name: "stops when a compacted request still cannot fit",
    provider: "arena",
    budget: "stop",
    auto: true,
    large: true,
    result: "stop",
    calls: 0,
  },
  {
    name: "sends a request under the full budget",
    provider: "arena",
    budget: "compact",
    auto: true,
    large: false,
    result: "continue",
    calls: 1,
  },
  {
    name: "honors disabled automatic compaction",
    provider: "arena",
    budget: "compact",
    auto: false,
    large: true,
    result: "continue",
    calls: 1,
  },
  {
    name: "leaves non-Arena requests unchanged",
    provider: "test",
    budget: "compact",
    auto: true,
    large: true,
    result: "continue",
    calls: 1,
  },
] as const) {
  let calls = 0
  const language = new MockLanguageModelV3({
    doStream: async () => {
      calls++
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
          const dispatch = scenario.calls === 0 ? waitForInitialDispatch(session.id) : undefined
          const result = yield* handle.process({
            user,
            sessionID: session.id,
            model,
            agent: { name: "build", mode: "primary", prompt: "s".repeat(8_000 * 4), options: {}, permission: [] },
            system: ["s".repeat(8_000 * 4)],
            messages: [{ role: "user", content: scenario.large ? "x".repeat(260_000 * 4) : "hello" }],
            tools: {},
            arenaRequestBudget: scenario.budget,
          })
          expect(result).toBe(scenario.result)
          expect(calls).toBe(scenario.calls)
          if (dispatch) yield* Effect.promise(() => dispatch.promise).pipe(Effect.timeout("1 second"))
          if (scenario.result === "stop") {
            expect(handle.message.error).toMatchObject({
              data: {
                message:
                  "The request exceeds the context budget. Reduce attached context or enabled tools and try again.",
              },
            })
          } else expect(handle.message.error).toBeUndefined()
        }),
      { config: { compaction: { auto: scenario.auto } } },
    ),
  )
}
