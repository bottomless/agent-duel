import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText, tool } from "ai"
import type { ArenaDb, Fetch } from "@agent-duel/arena-service"
import { createArenaService } from "@agent-duel/arena-service"
import z from "zod"

const userID = "reasoning-test-user"
const scopeID = "reasoning-test-scope"
const assignmentID = "reasoning-test-assignment"
const serverKey = "reasoning-test-server-key"
const model = {
  displayName: "Hidden test model",
  slug: "provider/hidden-test-model",
  canonicalSlug: "provider/hidden-test-model-v1",
  contextWindow: 128_000,
  routing: { sort: "throughput" },
} as const

const assignmentSet = {
  _id: "reasoning-test-set",
  userId: userID,
  scopeID,
  kind: "battle" as const,
  assignments: [{ assignmentID, model }],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
}

function bodyValue(body: RequestInit["body"]) {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer)
  return JSON.parse(text) as Record<string, unknown>
}

function sse(chunks: readonly unknown[], fragmentBytes = 2) {
  const bytes = new TextEncoder().encode(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
  )
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close()
          return
        }
        const end = Math.min(offset + fragmentBytes, bytes.length)
        controller.enqueue(bytes.slice(offset, end))
        offset = end
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const firstResponseChunks = [
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          reasoning_details: [
            { type: "reasoning.text", text: "Private first ", format: "anthropic-claude-v1", index: 0 },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [
      {
        index: 0,
        delta: {
          reasoning_details: [
            {
              type: "reasoning.text",
              text: "private second",
              signature: "provider-signature-secret",
              format: "anthropic-claude-v1",
              index: 0,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [
      {
        index: 0,
        delta: {
          reasoning_details: [
            {
              type: "reasoning.encrypted",
              data: "provider-encrypted-secret",
              format: "openai-responses-v1",
              index: 1,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-weather",
              type: "function",
              function: { name: "lookup", arguments: '{"city":"Par' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'is"}' } }],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "private-generation",
    model: model.slug,
    provider: "private-provider",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  },
] as const

const followUpChunks = [
  {
    id: "private-follow-up",
    model: model.slug,
    provider: "private-provider",
    choices: [{ index: 0, delta: { role: "assistant", content: "The weather is sunny." }, finish_reason: null }],
  },
  {
    id: "private-follow-up",
    model: model.slug,
    provider: "private-provider",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
  },
] as const

function syntheticUpstream(
  bodies: Record<string, unknown>[],
  chunks: readonly unknown[] = firstResponseChunks,
  fragmentBytes = 2,
) {
  let calls = 0
  const fetch: Fetch = async (_input, init) => {
    bodies.push(bodyValue(init?.body))
    calls++
    return sse(calls === 1 ? chunks : followUpChunks, fragmentBytes)
  }
  return fetch
}

describe("Arena reasoning redaction through the real SDK", () => {
  test.each([1, 16_384])("restores %s fragments in a compact SDK continuation", async (count) => {
    const text = count === 1 ? "Private first " : "abcd"
    const chunks = [
      ...Array.from({ length: count }, () => ({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text, format: "anthropic-claude-v1", index: 0 }],
            },
            finish_reason: null,
          },
        ],
      })),
      ...firstResponseChunks.slice(1),
    ]
    const fragmentBytes = count === 1 ? 2 : 2048
    const upstreamBodies: Record<string, unknown>[] = []
    const requestBytes: number[] = []
    const proxyStreams: Promise<string>[] = []
    const upstream = syntheticUpstream(upstreamBodies, chunks, fragmentBytes)

    const db = {
      collection: () => ({
        find: () => ({ toArray: async () => [assignmentSet] }),
        replaceOne: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }),
      }),
    } as unknown as ArenaDb
    const service = createArenaService({
      resolveCaller: async () => ({ id: userID }),
      db: async () => db,
      pool: [],
      openRouterApiKey: serverKey,
      validateModels: async () => {},
      fetch: upstream,
    })
    const modelClient = createOpenRouter({
      apiKey: "client-key",
      baseURL: "https://arena.local/api/openrouter/api/v1",
      fetch: async (input, init) => {
        requestBytes.push(Buffer.byteLength(JSON.stringify(bodyValue(init?.body))))
        const headers = new Headers(init?.headers)
        headers.set("X-Arena-Assignment-ID", assignmentID)
        headers.set("X-Arena-Scope-ID", scopeID)
        headers.set("X-Arena-Generation-ID", `gen_${"a".repeat(32)}`)
        const response = await service.route(new Request(input, { ...init, headers }))
        if (!response) throw new Error("Arena route did not answer the SDK request")
        proxyStreams.push(response.clone().text())
        return response
      },
    })
    const sdkModel = modelClient.chat("contestant")
    const lookup = tool({
      description: "Look up the weather",
      inputSchema: z.object({ city: z.string() }),
    })

    const first = streamText({
      model: sdkModel,
      prompt: "What is the weather in Paris?",
      tools: { lookup },
      toolChoice: "required",
      maxRetries: 0,
    })
    for await (const _event of first.fullStream) {
      // Consume the real provider stream so response.messages is finalized.
    }
    const firstResponse = await first.response
    expect(firstResponse.messages).toHaveLength(1)
    expect(firstResponse.messages[0]).toMatchObject({ role: "assistant" })

    const continuation = streamText({
      model: sdkModel,
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        ...firstResponse.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-weather",
              toolName: "lookup",
              output: { type: "text", value: "Paris is sunny." },
            },
          ],
        },
      ],
      tools: { lookup },
      maxRetries: 0,
    })
    for await (const _event of continuation.fullStream) {
      // Consume the second real provider stream.
    }

    const baselineBodies: Record<string, unknown>[] = []
    const baselineModel = createOpenRouter({
      apiKey: "client-key",
      fetch: syntheticUpstream(baselineBodies, chunks, fragmentBytes),
    }).chat("contestant")
    const baselineFirst = streamText({
      model: baselineModel,
      prompt: "What is the weather in Paris?",
      tools: { lookup },
      toolChoice: "required",
      maxRetries: 0,
    })
    for await (const _event of baselineFirst.fullStream) {
      // Consume the unshielded provider stream.
    }
    const baselineResponse = await baselineFirst.response
    const baselineContinuation = streamText({
      model: baselineModel,
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        ...baselineResponse.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-weather",
              toolName: "lookup",
              output: { type: "text", value: "Paris is sunny." },
            },
          ],
        },
      ],
      tools: { lookup },
      maxRetries: 0,
    })
    for await (const _event of baselineContinuation.fullStream) {
      // Consume the unshielded continuation.
    }

    expect(upstreamBodies).toHaveLength(2)
    expect(requestBytes).toHaveLength(2)
    expect(requestBytes[1]).toBeLessThan(256 * 1024)
    expect(baselineBodies).toHaveLength(2)
    expect(upstreamBodies[0]).toMatchObject({ model: model.slug })
    expect(upstreamBodies[1]).toMatchObject({ model: model.slug })
    const firstUpstream = JSON.stringify(upstreamBodies[0])
    const secondUpstream = JSON.stringify(upstreamBodies[1])
    expect(firstUpstream).not.toContain("[Thinking redacted]")
    expect(secondUpstream).not.toContain("[Thinking redacted]")
    expect(secondUpstream).not.toContain("arena_reasoning_v1.")
    const secondMessages = upstreamBodies[1]?.messages
    expect(secondMessages).toEqual([
      { role: "user", content: "What is the weather in Paris?" },
      {
        role: "assistant",
        content: "",
        reasoning: text.repeat(count) + "private second",
        tool_calls: [
          {
            id: "call-weather",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"Paris"}' },
          },
        ],
        reasoning_details: [
          {
            type: "reasoning.text",
            text: text.repeat(count) + "private second",
            signature: "provider-signature-secret",
            format: "anthropic-claude-v1",
            index: 0,
          },
          { type: "reasoning.encrypted", data: "provider-encrypted-secret", format: "openai-responses-v1", index: 1 },
        ],
      },
      { role: "tool", tool_call_id: "call-weather", content: "Paris is sunny.", name: "lookup" },
    ])
    expect(baselineBodies[1]?.messages).toEqual(secondMessages)
    const streamedBodies = await Promise.all(proxyStreams)
    expect(streamedBodies).toHaveLength(2)
    expect(streamedBodies[0]).toContain("[Thinking redacted]")
    expect(streamedBodies[0]).toContain('arguments":"{\\"city\\":\\"Par')
    expect(streamedBodies[0]).not.toContain("Private first")
    expect(streamedBodies[0]).not.toContain("private second")
    expect(streamedBodies[0]).not.toContain("provider-signature-secret")
    expect(streamedBodies[0]).not.toContain("anthropic-claude-v1")
    expect(streamedBodies[0]).not.toContain("openai-responses-v1")
    expect(streamedBodies[0]).not.toContain("provider-encrypted-secret")
    expect(streamedBodies[0]).toContain("tool_calls")
    expect(streamedBodies[0]).toContain("[DONE]")
  })

  test("forwards the first redacted reasoning chunk while the upstream stream is gated", async () => {
    const gate = Promise.withResolvers<void>()
    const upstreamWaiting = Promise.withResolvers<void>()
    const firstRaw = Promise.withResolvers<string>()
    let firstPacket = true
    let released = false
    const upstream: Fetch = async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (firstPacket) {
              firstPacket = false
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: "gated-generation",
                    model: model.slug,
                    provider: "private-provider",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          reasoning_details: [
                            {
                              type: "reasoning.text",
                              text: "gated private reasoning",
                              signature: "gated-provider-signature",
                              format: "anthropic-claude-v1",
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              )
              return
            }
            if (!released) {
              upstreamWaiting.resolve()
              await gate.promise
              released = true
            }
            controller.enqueue(
              encoder.encode(
                [
                  {
                    id: "gated-generation",
                    model: model.slug,
                    provider: "private-provider",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "gated-call",
                              type: "function",
                              function: { name: "lookup", arguments: '{"city":"Paris"}' },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "gated-generation",
                    model: model.slug,
                    provider: "private-provider",
                    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                  },
                ]
                  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                  .concat("data: [DONE]\n\n")
                  .join(""),
              ),
            )
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const db = {
      collection: () => ({
        find: () => ({ toArray: async () => [assignmentSet] }),
      }),
    } as unknown as ArenaDb
    const service = createArenaService({
      resolveCaller: async () => ({ id: userID }),
      db: async () => db,
      pool: [],
      openRouterApiKey: serverKey,
      validateModels: async () => {},
      fetch: upstream,
    })
    const modelClient = createOpenRouter({
      apiKey: "client-key",
      baseURL: "https://arena.local/api/openrouter/api/v1",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("X-Arena-Assignment-ID", assignmentID)
        headers.set("X-Arena-Scope-ID", scopeID)
        const response = await service.route(new Request(input, { ...init, headers }))
        if (!response) throw new Error("Arena route did not answer the gated SDK request")
        const reader = response.clone().body!.getReader()
        void (async () => {
          const decoder = new TextDecoder()
          let text = ""
          while (true) {
            const next = await reader.read()
            if (next.done) return
            text += decoder.decode(next.value, { stream: true })
            if (text.includes("[Thinking redacted]")) {
              firstRaw.resolve(text)
              return
            }
          }
        })()
        return response
      },
    })
    const gatedModel = modelClient.chat("contestant")
    const lookup = tool({ inputSchema: z.object({ city: z.string() }) })
    const result = streamText({
      model: gatedModel,
      prompt: "Use lookup for Paris.",
      tools: { lookup },
      toolChoice: "required",
      includeRawChunks: true,
      maxRetries: 0,
    })
    const draining = (async () => {
      for await (const _event of result.fullStream) {
        // Keep the real SDK consumer active while the upstream is gated.
      }
    })()
    const [raw] = await Promise.race([
      Promise.all([firstRaw.promise, upstreamWaiting.promise]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gated stream did not reach the client")), 2_000),
      ),
    ])
    expect(raw).toContain("[Thinking redacted]")
    expect(raw).not.toContain("gated private reasoning")
    expect(raw).not.toContain("gated-provider-signature")
    expect(raw).not.toContain("anthropic-claude-v1")
    gate.resolve()
    await draining
  })
})
