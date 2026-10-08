import { expect, test } from "bun:test"
import { streamText, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import z from "zod"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { timeoutModelIdle } from "@/arena/model-idle"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { LLM } from "@/session/llm"
import { Effect, Fiber, Stream } from "effect"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("cancelling the stream aborts a pending local tool before closing its iterator", async () => {
  const abort = new AbortController()
  const pending = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  let toolAborted = false
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "tool-call", toolCallId: "tool-1", toolName: "slow", input: "{}" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }),
  })
  const result = streamText({
    model,
    abortSignal: abort.signal,
    messages: [{ role: "user", content: "Run the tool" }],
    tools: {
      slow: tool({
        inputSchema: z.object({}),
        execute: async (_, options) => {
          options.abortSignal!.addEventListener(
            "abort",
            () => {
              toolAborted = true
              release.resolve("aborted")
            },
            { once: true },
          )
          return release.promise
        },
      }),
    },
  })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => abort.abort()))
        return Stream.fromAsyncIterable(timeoutModelIdle(result.fullStream, abort, 120_000), (error) => error).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "tool-call") pending.resolve()
            }),
          ),
        )
      }),
    ),
  )
  const fiber = Effect.runFork(Stream.runDrain(stream))
  await pending.promise
  const cancelled = Effect.runPromise(Fiber.interrupt(fiber))
  try {
    const completed = await Promise.race([cancelled.then(() => true), sleep(1_000).then(() => false)])
    expect(completed).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    expect(toolAborted).toBe(true)
  } finally {
    release.resolve("cleanup")
    await cancelled
  }
})

test("a silent model stream fails and aborts its request", async () => {
  const abort = new AbortController()
  async function* stream() {
    yield { type: "start" }
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
  }

  const events: string[] = []
  await expect(async () => {
    for await (const event of timeoutModelIdle(stream(), abort, 30)) events.push(event.type)
  }).toThrow(ProviderError.ResponseStreamError)
  expect(events).toEqual(["start"])
  expect(abort.signal.aborted).toBe(true)
})

test("a model idle error enters the Arena retry policy", () => {
  const error = MessageV2.fromError(new ProviderError.ResponseStreamError("Arena model response was idle"), {
    providerID: ProviderV2.ID.make("arena"),
    aborted: false,
  })
  expect(SessionRetry.retryable(error, "arena")).toBeDefined()
})

test("model activity keeps the stream alive", async () => {
  const abort = new AbortController()
  async function* stream() {
    yield { type: "start" }
    await sleep(10)
    yield { type: "text-delta" }
    await sleep(10)
    yield { type: "finish" }
  }

  const events: string[] = []
  for await (const event of timeoutModelIdle(stream(), abort, 150)) events.push(event.type)
  expect(events).toEqual(["start", "text-delta", "finish"])
  expect(abort.signal.aborted).toBe(false)
})

test("long local tool work is excluded, then the model deadline resumes", async () => {
  const abort = new AbortController()
  async function* stream() {
    yield { type: "tool-call", toolCallId: "tool-1" }
    await sleep(150)
    yield { type: "tool-result", toolCallId: "tool-1" }
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
  }

  const events: string[] = []
  await expect(async () => {
    for await (const event of timeoutModelIdle(stream(), abort, 60)) events.push(event.type)
  }).toThrow(ProviderError.ResponseStreamError)
  expect(events).toEqual(["tool-call", "tool-result"])
})

test("provider-executed tools do not suspend the model deadline", async () => {
  const abort = new AbortController()
  async function* stream() {
    yield { type: "tool-call", toolCallId: "remote-1", providerExecuted: true }
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
  }

  await expect(async () => {
    for await (const _ of timeoutModelIdle(stream(), abort, 30)) {
      // Consume the initial tool call.
    }
  }).toThrow(ProviderError.ResponseStreamError)
})

test("AI SDK emits tool activity while a local tool runs", async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "tool-call", toolCallId: "tool-1", toolName: "slow", input: "{}" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }),
  })
  const result = streamText({
    model,
    messages: [{ role: "user", content: "Run the tool" }],
    tools: {
      slow: tool({
        inputSchema: z.object({}),
        execute: async () => {
          await sleep(250)
          return "done"
        },
      }),
    },
  })
  const abort = new AbortController()
  const events: string[] = []
  for await (const event of timeoutModelIdle(result.fullStream, abort, 100)) events.push(event.type)
  expect(events).toContain("tool-call")
  expect(events).toContain("tool-result")
  expect(abort.signal.aborted).toBe(false)
})

test("model silence after a tool result is bounded even if the model stream remains open", async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "tool-call", toolCallId: "tool-1", toolName: "slow", input: "{}" })
        },
      }),
    }),
  })
  const abort = new AbortController()
  const result = streamText({
    model,
    abortSignal: abort.signal,
    messages: [{ role: "user", content: "Run the tool" }],
    tools: {
      slow: tool({
        inputSchema: z.object({}),
        execute: async () => {
          await sleep(250)
          return "done"
        },
      }),
    },
  })
  const events: string[] = []
  await expect(async () => {
    for await (const event of timeoutModelIdle(result.fullStream, abort, 100)) events.push(event.type)
  }).toThrow(ProviderError.ResponseStreamError)
  expect(events).toContain("tool-call")
  expect(events).toContain("tool-result")
})

// OpenRouter can stream minutes of contestant reasoning only as `reasoning_details`, with no text.
function reasoningDetailsOnlyModel() {
  const encoder = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "contestant",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    )
  return createOpenRouter({
    apiKey: "test-key",
    fetch: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(chunk({ role: "assistant", content: "", reasoning: "Planning" }))
            for (let index = 0; index < 8; index++) {
              await sleep(40)
              controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"))
              controller.enqueue(
                chunk({
                  role: "assistant",
                  content: "",
                  reasoning: null,
                  reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }],
                }),
              )
            }
            controller.enqueue(chunk({ role: "assistant", content: "Done" }))
            controller.enqueue(chunk({}, "stop"))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  }).chat("contestant")
}

test("reasoning sent only as provider details keeps an Arena stream alive", async () => {
  const abort = new AbortController()
  const result = streamText({
    model: reasoningDetailsOnlyModel(),
    abortSignal: abort.signal,
    messages: [{ role: "user", content: "Think hard" }],
    ...LLM.arenaStreamOptions,
  })
  const events: string[] = []
  for await (const event of timeoutModelIdle(result.fullStream, abort, 150)) events.push(event.type)
  expect(events).toContain("text-delta")
  expect(events.at(-1)).toBe("finish")
  expect(abort.signal.aborted).toBe(false)
})

test("without raw chunks, reasoning sent only as provider details looks idle", async () => {
  const abort = new AbortController()
  const result = streamText({
    model: reasoningDetailsOnlyModel(),
    abortSignal: abort.signal,
    messages: [{ role: "user", content: "Think hard" }],
  })
  await expect(async () => {
    for await (const _ of timeoutModelIdle(result.fullStream, abort, 150)) {
      // Consume until the deadline fires.
    }
  }).toThrow(ProviderError.ResponseStreamError)
})
