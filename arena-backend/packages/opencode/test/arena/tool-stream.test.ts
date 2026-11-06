import { describe, expect, test, spyOn } from "bun:test"
import { LLM, LLMEvent } from "@opencode/ai"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { AISDK } from "@opencode/core/aisdk"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import type { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { update, type Adapter } from "@opencode/core/session/message-updater"
import { createLLMEventPublisher } from "@opencode/core/session/runner/publish-llm-event"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionSchema } from "@opencode/core/session/schema"
import { Agent } from "@opencode/core/agent"
import { Event } from "@opencode/schema/event"
import { MockLanguageModelV3 } from "ai/test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { Effect, Layer, Schema, Stream } from "effect"
import { withHeldToolCalls } from "../../src/arena/engine-runtime/tool-stream"

const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
    ),
  ),
)

const model: Model.RuntimeInfo = {
  ...Model.Info.make({
    ...Model.Info.default(Provider.ID.make("arena"), Model.ID.make("contestant")),
    package: Provider.aisdk("@openrouter/ai-sdk-provider"),
    limit: { context: 100, output: 20 },
  }),
  settings: {},
}

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", model: "m", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

/** One SSE body with each call's argument pieces in turn. The first piece carries the id and name. */
const sse = (calls: ReadonlyArray<ReadonlyArray<string>>, end: "finish" | "cut" = "finish") => {
  const lines = calls.flatMap((pieces, index) =>
    pieces.map((args, piece) =>
      chunk({
        role: "assistant",
        tool_calls: [
          piece === 0
            ? { index, id: `call_${index}`, type: "function", function: { name: "read", arguments: args } }
            : { index, function: { arguments: args } },
        ],
      }),
    ),
  )
  return end === "cut" ? lines.join("") : `${lines.join("")}${chunk({}, "tool_calls")}data: [DONE]\n\n`
}

const respond = (body: string) => async () => new Response(body, { headers: { "content-type": "text/event-stream" } })

const reset = (body: string) => async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        setTimeout(() => controller.error(new Error("connection reset")), 20)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

/** Real OpenRouter SDK, the wrapper, and Core's AI SDK adapter: what the session publisher receives. */
const events = (
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  messages: ReturnType<typeof toLLMMessages> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* aisdk.hook.sdk((event) => {
        event.sdk = createOpenRouter({ apiKey: "test", fetch })
      })
      yield* aisdk.hook.language((event) => {
        event.language = withHeldToolCalls(event.sdk.languageModel("m"))
      })
      const resolved = yield* aisdk.model(model)
      const stream = LLMClient.stream(LLM.request({ model: resolved, messages, prompt: "Go" }))
      const result: LLMEvent[] = []
      yield* stream.pipe(
        Stream.runForEach((event) => Effect.sync(() => void result.push(event))),
        Effect.catch((error) => Effect.sync(() => void result.push({ type: "failed", error } as unknown as LLMEvent))),
      )
      return result
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(AISDK.locationLayer, client))),
  )

const toolEvents = (all: readonly LLMEvent[]) =>
  all.flatMap((event): string[] => {
    switch (event.type) {
      case "tool-input-start":
        return [`start ${event.id}`]
      case "tool-input-delta":
        return [`delta ${event.id} ${event.text}`]
      case "tool-input-end":
        return [`end ${event.id}`]
      case "tool-call":
        return [`call ${event.id} ${JSON.stringify(event.input)}`]
      case "tool-input-error":
        return [`invalid ${event.id} ${event.raw}`]
      case "finish":
        return ["finish"]
      default:
        return []
    }
  })

/** Real publisher and history projection, with only the message store kept in memory. */
const failedHistory = (all: readonly LLMEvent[], providerID: string, type: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const messages: SessionMessage.Info[] = []
      const adapter: Adapter = {
        getAgent: () => Effect.succeed(undefined),
        getModel: () => Effect.succeed(undefined),
        getLocation: () => Effect.succeed(undefined),
        getCurrentAssistant: () => Effect.succeed(messages.findLast((message) => message.type === "assistant")),
        getAssistant: (id) =>
          Effect.succeed(messages.find((message) => message.type === "assistant" && message.id === id)),
        getShell: () => Effect.succeed(undefined),
        getCompaction: () => Effect.succeed(undefined),
        updateAssistant: (message) =>
          Effect.sync(() => {
            messages[messages.findIndex((item) => item.id === message.id)] = message
          }),
        updateShell: () => Effect.die("Unexpected shell update"),
        updateCompaction: () => Effect.die("Unexpected compaction update"),
        appendMessage: (message) =>
          Effect.sync(() => {
            messages.push(message)
          }),
      }
      const bus: Pick<Bus.Interface, "publish"> = {
        publish: (definition, data) =>
          Effect.gen(function* () {
            const event = Schema.decodeUnknownSync(definition)(
              JSON.parse(
                JSON.stringify({
                  id: Event.ID.create(),
                  type: definition.type,
                  data,
                  created: 0,
                  durable: { aggregateID: "ses_held", seq: 0, version: definition.durable?.version },
                }),
              ),
            )
            if (definition.durable) yield* update(adapter, Schema.decodeUnknownSync(SessionEvent.Durable)(event))
            return event
          }),
      }
      const ref = { id: model.id, providerID: Provider.ID.make(providerID) }
      const publisher = createLLMEventPublisher(bus, {
        sessionID: SessionSchema.ID.make("ses_held"),
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.defaultID,
        model: ref,
        providerMetadataKey: "openai",
        started: 0,
      })
      for (const event of all) {
        if (event.type === "tool-input-start" || event.type === "tool-input-delta") yield* publisher.publish(event)
      }
      yield* publisher.failAssistant({ type, message: "Stream cut" })
      yield* publisher.publishStepFailure()
      return { messages, history: toLLMMessages(messages, ref) }
    }),
  )

describe("withHeldToolCalls", () => {
  test("drops the empty chunk Qwen 3.8 Max sends after the closing brace", async () => {
    // The order captured from the live route: arguments in pieces, then one chunk with "".
    expect(toolEvents(await events(respond(sse([['{"path":', '"a.js"}', ""]]))))).toEqual([
      "start call_0",
      'delta call_0 {"path":',
      'delta call_0 "a.js"}',
      "end call_0",
      'call call_0 {"path":"a.js"}',
      "finish",
    ])
  })

  test("keeps the same arguments when a whitespace chunk follows", async () => {
    expect(toolEvents(await events(respond(sse([['{"path":"a.js"}', "\n"]]))))).toEqual([
      "start call_0",
      'delta call_0 {"path":"a.js"}',
      "delta call_0 \n",
      "end call_0",
      'call call_0 {"path":"a.js"}',
      "finish",
    ])
  })

  test("does not call a tool with the arguments a late chunk would change", async () => {
    // Without the hold the SDK delivers call {} here, and the tool starts before the real arguments.
    const seen = toolEvents(await events(respond(sse([["{}", '{"path":"a.js"}']]))))
    expect(seen.filter((event) => event.startsWith("call"))).toEqual([])
    expect(seen).toEqual([
      "start call_0",
      "delta call_0 {}",
      'delta call_0 {"path":"a.js"}',
      "end call_0",
      'invalid call_0 {}{"path":"a.js"}',
      "finish",
    ])
  })

  test("delivers parallel calls in order, each with its own arguments", async () => {
    const seen = toolEvents(
      await events(
        respond(
          sse([
            ['{"a":1}', ""],
            ['{"b":2}', ""],
          ]),
        ),
      ),
    )
    expect(seen.filter((event) => event.startsWith("call"))).toEqual(['call call_0 {"a":1}', 'call call_1 {"b":2}'])
    expect(seen.at(-1)).toBe("finish")
  })

  test("runs nothing when the stream breaks before the model finishes", async () => {
    const seen = await events(reset(sse([['{"path":"a.js"}']], "cut")))
    expect(toolEvents(seen).filter((event) => event.startsWith("call") || event === "finish")).toEqual([])
    expect(seen.at(-1)?.type).not.toBe("finish")
  })

  test("keeps complete held input in failed Arena history without releasing a call", async () => {
    const seen = await events(reset(sse([['{"path":"a.js"}', ""]], "cut")))
    expect(toolEvents(seen)).toEqual(["start call_0", 'delta call_0 {"path":"a.js"}'])
    for (const type of ["provider.internal", "provider.transport", "aborted"]) {
      const { messages, history } = await failedHistory(seen, "arena", type)
      expect(messages).toMatchObject([
        {
          content: [
            {
              id: "call_0",
              state: { status: "error", input: { path: "a.js" }, error: { type } },
            },
          ],
        },
      ])
      expect(
        messages
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .filter((part) => part.type === "tool")
          .map((part) => part.time.ran),
      ).toEqual([undefined])
      expect(history.flatMap((message) => message.content).filter((part) => part.type === "tool-call")).toMatchObject([
        { id: "call_0", input: { path: "a.js" } },
      ])
      let outbound = ""
      await events(async (_input, init) => {
        outbound = String(init?.body)
        return respond(`${chunk({ role: "assistant", content: "hi" })}${chunk({}, "stop")}data: [DONE]\n\n`)()
      }, history)
      expect(JSON.parse(outbound)).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [{ id: "call_0", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } }],
          }),
        ]),
      })
    }
    const unchanged = await failedHistory(seen, "opencode", "provider.internal")
    expect(unchanged.messages).toMatchObject([{ content: [{ state: { status: "error", input: {} } }] }])
    const incomplete = await failedHistory(
      [
        LLMEvent.toolInputStart({ id: "call_0", name: "read" }),
        LLMEvent.toolInputDelta({ id: "call_0", name: "read", text: '{"path":' }),
      ],
      "arena",
      "aborted",
    )
    expect(incomplete.messages).toMatchObject([{ content: [{ state: { status: "error", input: {} } }] }])
    const resent = await events(respond(sse([['{"path":"a.js"}', ""]])))
    expect(toolEvents([...seen, ...resent]).filter((event) => event.startsWith("call"))).toEqual([
      'call call_0 {"path":"a.js"}',
    ])
  })

  test("leaves a stream without tool calls alone", async () => {
    const body = `${chunk({ role: "assistant", content: "hi" })}${chunk({}, "stop")}data: [DONE]\n\n`
    const seen = await events(respond(body))
    expect(seen.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["hi"])
    expect(toolEvents(seen)).toEqual(["finish"])
  })
})

test("long tool argument streams keep reporting activity without executing a held call", async () => {
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  let source!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const activity: string[] = []
  try {
    const language = withHeldToolCalls(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              source = controller
            },
          }),
        }),
      }),
      (sessionID) => activity.push(sessionID),
    )
    const result = await language.doStream({ prompt: [], headers: { "x-arena-session-id": "streaming-session" } })
    const reader = result.stream.getReader()
    source.enqueue({ type: "tool-input-start", id: "call", toolName: "read" })
    await reader.read()
    for (let seconds = 0; seconds < 360; seconds += 6) {
      now += 6_000
      source.enqueue({ type: "tool-input-delta", id: "call", delta: "bytes" })
      expect((await reader.read()).value?.type).toBe("tool-input-delta")
    }
    // The start counts too, then each delta at least 5 s after the last report.
    expect(activity).toEqual(Array(61).fill("streaming-session"))
    now += 6_000
    source.enqueue({ type: "tool-input-delta", id: "call", delta: "" })
    await reader.read()
    expect(activity).toHaveLength(61)
    source.close()
    await reader.cancel()
  } finally {
    clock.mockRestore()
  }
})

test("sealed reasoning with no text keeps reporting activity", async () => {
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  let source!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const activity: string[] = []
  try {
    const language = withHeldToolCalls(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              source = controller
            },
          }),
        }),
      }),
      (sessionID) => activity.push(sessionID),
    )
    const result = await language.doStream({ prompt: [], headers: { "x-arena-session-id": "reasoning-session" } })
    const reader = result.stream.getReader()
    source.enqueue({ type: "reasoning-start", id: "r" })
    await reader.read()
    // Ten minutes of empty reasoning deltas, one a second, as a sealed-reasoning provider sends them.
    for (let seconds = 0; seconds < 600; seconds++) {
      now += 1_000
      source.enqueue({ type: "reasoning-delta", id: "r", delta: "" })
      expect((await reader.read()).value?.type).toBe("reasoning-delta")
    }
    // One report at the start, then one every 5 s: never 90 s of silence.
    expect(activity).toHaveLength(121)
    source.close()
    await reader.cancel()
  } finally {
    clock.mockRestore()
  }
})
