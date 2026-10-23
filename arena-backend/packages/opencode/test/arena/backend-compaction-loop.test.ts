import { expect } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { createArenaService } from "@agent-duel/arena-service"
import { Provider } from "@/provider/provider"
import { ArenaRuntime } from "@/arena/runtime"
import { proxy } from "@/arena/proxy"
import { connectLocalStore } from "@/arena/local-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { MessageV2 } from "@/session/message-v2"
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

for (const oversizedNewMessage of [false, true]) {
  let service: ReturnType<typeof createArenaService>
  const publicResponses: string[] = []
  const generations: string[] = []
  const summaries: string[] = []
  const capabilities = ProviderTest.model().capabilities
  const model = ProviderTest.model({
    providerID: ProviderV2.ID.make("arena"),
    id: ModelV2.ID.make("contestant"),
    limit: { context: 500_000, output: 32_000 },
    api: { id: "contestant", url: "https://arena.invalid/api/v1", npm: "@openrouter/ai-sdk-provider" },
    capabilities: { ...capabilities, attachment: true, input: { ...capabilities.input, image: true } },
  })
  const language = createOpenRouter({
    apiKey: "test",
    fetch: async (url, init) =>
      proxy(new Request(url, init), ArenaRuntime.registry, {
        upstream: "https://control.test/api/openrouter",
        fetch: async (input, options) => {
          const response = await service.openrouter(new Request(input, options))
          publicResponses.push(await response.clone().text())
          return response
        },
      }),
  }).chat("contestant")
  const provider = ProviderTest.fake({ model, getLanguage: () => Effect.succeed(language) })
  const env = LayerNode.compile(
    LayerNode.group([Session.node, SessionPrompt.node, SessionProjector.node, CrossSpawnSpawner.node]),
    [
      [Provider.node, provider.layer],
      [SessionSummary.node, summary],
    ],
  )
  const it = testEffect(env)
  const name = oversizedNewMessage
    ? "stops an irreducible new request after one backend-triggered compaction"
    : "resumes a narrow assigned model through SDK, both proxies and the real session loop"
  it.live(
    name,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompts = yield* SessionPrompt.Service
          const store = yield* Effect.acquireRelease(
            Effect.promise(() => connectLocalStore({ directory: `${dir}/control-store` })),
            (value) => Effect.promise(() => value.close()),
          )
          const privateModel = {
            displayName: "Private small model",
            slug: "private/small-model",
            canonicalSlug: "private/small-model",
            contextWindow: 65_536,
            limits: { context: 65_536, output: 8_192 },
            routing: {},
          }
          service = createArenaService({
            resolveCaller: async () => ({ id: "test-user" }),
            db: async () => store.db,
            pool: [privateModel],
            openRouterApiKey: "test-key",
            validateModels: async () => {},
            uuid: () => "opaque",
            fetch: async (input, init) => {
              const request = new Request(input, init)
              const body = await request.json()
              const text = JSON.stringify(body.messages)
              const generation = Array.isArray(body.tools) && body.tools.length > 0
              if (generation) generations.push(text)
              else summaries.push(text)
              const content = generation
                ? "TASK_COMPLETE"
                : "Preserved original task and completed work. Continue the pending request."
              return new Response(
                [
                  `data: ${JSON.stringify({ id: "private-generation", model: privateModel.slug, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
                  `data: ${JSON.stringify({ id: "private-generation", model: privateModel.slug, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}`,
                  "data: [DONE]",
                  "",
                ].join("\n\n"),
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          })
          const assigned = yield* Effect.promise(() =>
            service.assignments(
              new Request("https://control.test/api/arena/assignments", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "create", kind: "single", scopeID: "test-scope" }),
              }),
            ),
          )
          expect(assigned.status).toBe(200)
          expect(yield* Effect.promise(() => assigned.json())).toEqual({ assignments: [{ assignmentID: "opaque" }] })
          const chat = yield* sessions.create({
            title: "Compaction fixture",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          ArenaRuntime.registry.assign(chat.id, {
            runID: "run",
            rootSessionID: chat.id,
            scopeID: "test-scope",
            assignmentID: "opaque",
            telemetry: false,
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              ArenaRuntime.registry.assignments.delete(chat.id)
            }),
          )
          const history = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: history.id,
            type: "text",
            text: "HISTORY_START " + "h".repeat(70_000 * 4) + " HISTORY_END",
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            parentID: history.id,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            agent: "build",
            mode: "build",
            finish: "stop",
            modelID: model.id,
            providerID: model.providerID,
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: assistant.id,
            type: "text",
            text: "Previous work completed.",
          })
          const pending = oversizedNewMessage
            ? "PENDING_REQUEST " + "p".repeat(70_000 * 4)
            : "PENDING_REQUEST: finish the task."
          const attachment = {
            type: "file" as const,
            mime: "image/webp",
            filename: "pending.webp",
            url: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
          }
          yield* prompts.prompt({
            sessionID: chat.id,
            model: { providerID: model.providerID, modelID: model.id },
            parts: [{ type: "text", text: pending }, attachment],
          })
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const compacted = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
          expect(compacted).toHaveLength(1)
          expect(summaries.length).toBeGreaterThan(1)
          expect(summaries.join("\n")).toContain("HISTORY_START")
          expect(summaries.join("\n")).toContain("HISTORY_END")
          expect(summaries.join("\n")).not.toContain("PENDING_REQUEST")
          expect(
            messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === pending)),
          ).toBe(true)
          expect(messages.flatMap((message) => message.parts)).toContainEqual(expect.objectContaining(attachment))
          expect(publicResponses.join("\n")).not.toContain(privateModel.slug)
          expect(publicResponses.join("\n")).not.toContain("65536")
          if (oversizedNewMessage) {
            expect(generations).toHaveLength(0)
            const last = MessageV2.latest(messages).assistant
            expect(last?.error).toMatchObject({ name: "APIError", data: { isRetryable: false } })
          } else {
            expect(generations).toHaveLength(1)
            expect(generations[0]).toContain(pending)
            expect(generations[0]).toContain(attachment.url)
            expect(generations[0]).not.toContain("HISTORY_START")
            expect(messages.at(-1)?.parts).toContainEqual(
              expect.objectContaining({ type: "text", text: "TASK_COMPLETE" }),
            )
          }
        }),
      { git: true },
    ),
  )
}
