import { expect } from "bun:test"
import { APICallError } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionSummary } from "@/session/summary"
import { MessageID } from "@/session/schema"
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
    name: "compacts on the backend signal without retrying generation",
    provider: "arena",
    auto: true,
    eligible: true,
    summary: false,
    result: "compact-request",
  },
  {
    name: "stops when a compacted request still cannot fit",
    provider: "arena",
    auto: true,
    eligible: false,
    summary: false,
    result: "stop",
  },
  {
    name: "honors disabled auto compaction on backend rejection",
    provider: "arena",
    auto: false,
    eligible: true,
    summary: false,
    result: "stop",
  },
  {
    name: "allows a manual summary to shrink its batches with auto disabled",
    provider: "arena",
    auto: false,
    eligible: false,
    summary: true,
    result: "compact-request",
  },
  {
    name: "preserves ordinary overflow handling for another provider",
    provider: "test",
    auto: true,
    eligible: true,
    summary: false,
    result: "compact",
  },
] as const) {
  let calls = 0
  const language = new MockLanguageModelV3({
    doStream: async () => {
      calls++
      throw new APICallError({
        message: "Arena request needs compaction",
        url: "https://arena.invalid/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 413,
        responseBody: JSON.stringify({
          error: { type: "arena_compaction_required", message: "Arena request needs compaction" },
        }),
        isRetryable: false,
      })
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
          const agent = scenario.summary ? "compaction" : "build"
          const user: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent,
            model: { providerID: model.providerID, modelID: model.id },
          }
          yield* sessions.updateMessage(user)
          const assistant: SessionV1.Assistant = {
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            time: { created: Date.now() },
            agent,
            mode: agent,
            modelID: model.id,
            providerID: model.providerID,
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          yield* sessions.updateMessage(assistant)
          const handle = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
          const result = yield* handle.process({
            user,
            sessionID: session.id,
            model,
            agent: { name: agent, mode: "primary", prompt: "Complete the request.", options: {}, permission: [] },
            system: [],
            messages: [{ role: "user", content: "Continue the task." }],
            tools: {},
            arenaRequestCompaction: scenario.eligible,
          })
          expect(result).toBe(scenario.result)
          expect(calls).toBe(1)
          expect(handle.message.error === undefined).toBe(scenario.result !== "stop")
        }),
      { config: { compaction: { auto: scenario.auto } } },
    ),
  )
}
