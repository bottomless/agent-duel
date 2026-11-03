import { expect } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { LLM, LLMClient } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { AISDK } from "@opencode/core/aisdk"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { createLLMEventPublisher } from "@opencode/core/session/runner/publish-llm-event"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionEvent } from "@opencode/core/session/event"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { withHeldToolCalls } from "../../src/arena/engine-runtime/tool-stream"
import { testEffect } from "../../../core/test/lib/effect"

const layer = Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node])),
  AISDK.locationLayer,
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.succeed(RequestExecutor.Service, {
        execute: () => Effect.die("Unexpected network request"),
      }),
    ),
  ),
)
const it = testEffect(layer)

const chunk = (delta: unknown, finish: string | null = null) =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  )

for (const [id, late] of [
  ["medium", "append"],
  ["contestant", "append"],
  ["medium", "extend"],
  ["contestant", "extend"],
] as const) {
  it.live(`${id} completes when late reasoning metadata must ${late} after projected answer text`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const aisdk = yield* AISDK.Service
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const projected = Promise.withResolvers<void>()
      const detail = { type: "reasoning.text", text: "[Thinking redacted]", format: "unknown" }
      const envelope = { type: "reasoning.encrypted", data: "opaque-continuation", format: "unknown" }
      const initial = late === "append" ? [detail, envelope] : [detail]
      const additional = { ...detail, text: "late", signature: "late-signature" }
      const complete =
        late === "append" ? [...initial, additional] : [{ ...additional, text: detail.text + additional.text }]
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk({ reasoning_details: initial }))
          controller.enqueue(chunk({ content: "The parent file is written; waiting for the background child." }))
        },
        async pull(controller) {
          await projected.promise
          if (sent) return
          sent = true
          controller.enqueue(chunk({ reasoning_details: [additional] }))
          controller.enqueue(chunk({}, "stop"))
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      yield* aisdk.hook.sdk((event) => {
        event.sdk = createOpenRouter({
          apiKey: "test",
          fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
        })
      })
      yield* aisdk.hook.language((event) => {
        event.language = withHeldToolCalls(event.sdk.languageModel(id))
      })
      const model = {
        ...Model.Info.make({
          ...Model.Info.default(Provider.ID.make("arena"), Model.ID.make(id)),
          package: Provider.aisdk("@openrouter/ai-sdk-provider"),
        }),
        settings: {},
      }
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: AbsolutePath.make("/project"),
          sandboxes: [],
        })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "readonly-stream",
          directory: "/project",
          version: "test",
        })
        .run()
      const publisher = createLLMEventPublisher(bus, {
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model: { id: model.id, providerID: model.providerID },
        providerMetadataKey: "openrouter",
        started: 0,
      })
      const resolved = yield* aisdk.model(model)
      yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Wait for the child" })).pipe(
        Stream.runForEach((event) =>
          publisher.publish(event).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (event.type === "reasoning-end") projected.resolve()
              }),
            ),
          ),
        ),
      )
      const finish = publisher.record().finish
      if (!finish) throw new Error("The provider did not finish")
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: finish.finish,
        providerState: finish.providerState,
        tokens: finish.tokens,
        cost: Money.USD.zero,
      })
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: "stop",
        content: [
          { type: "reasoning", state: { reasoning_details: initial } },
          { type: "text", text: "The parent file is written; waiting for the background child." },
        ],
        providerState: { reasoning_details: complete },
      })
      expect(message?.data).not.toHaveProperty("error")
      expect(message?.data).not.toHaveProperty("retry")
      expect(publisher.record().failure).toBeUndefined()
      expect(publisher.record().finish?.finish).toBe("stop")
    }),
  )
}
