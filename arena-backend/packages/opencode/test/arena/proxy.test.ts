import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"
import { Provider as ProviderV2 } from "@opencode/schema/provider"
import { SessionV1 } from "@opencode/schema/v1/session"
import { Effect } from "effect"
import {
  AssignmentRegistry,
  ArenaWaitError,
  proxy,
  rewriteBody,
  sanitizePayload,
  streamProgress,
} from "../../src/arena/proxy"
import { SessionRetry } from "../../src/session/retry"
import { createArenaService } from "@agent-duel/arena-service"
import { isNetworkUnavailable } from "@agent-duel/arena-service/network"
import { singleAgentAllowanceCode, singleAgentAllowanceError } from "@agent-duel/arena-service/request-error"
import type { ArenaDb } from "@agent-duel/arena-service/collection"

/**
 * Retry tests need only the assistant error wire shape. Keep this local so the pure proxy tests
 * don't pull the retired V1 message loader (which owns the daemon's legacy storage path).
 */
function assistantError(error: unknown, _providerID: ProviderV2.ID): SessionV1.Assistant["error"] {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
  const responseBody = typeof value?.responseBody === "string" ? value.responseBody : undefined
  const statusCode = typeof value?.statusCode === "number" ? value.statusCode : undefined
  const message = error instanceof Error ? error.message : String(error)
  return SessionV1.APIError.Schema.make({
    name: "APIError",
    data: {
      message,
      isRetryable: value?.isRetryable === true || statusCode === undefined || statusCode >= 500,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(responseBody === undefined ? {} : { responseBody }),
    },
  })
}

const assignment = {
  runID: "run-a",
  rootSessionID: "session-root",
  scopeID: "turn-a",
  assignmentID: "opaque-assignment",
  telemetry: true,
} as const

const requestID = "00000000-0000-4000-8000-000000000001"

function request(signal?: AbortSignal) {
  return new Request("http://arena.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": "session-root",
      "x-arena-request-id": requestID,
    },
    body: JSON.stringify({ model: "contestant", messages: [] }),
    signal,
  })
}

function transportError(code: string) {
  return Object.assign(new Error("private upstream address"), { code })
}

describe("ArenaProxy", () => {
  test("preserves only the neutral backend compaction signal for a descendant", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const chunks: string[] = []
    const response = await proxy(
      new Request("http://arena.invalid/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-child",
          "x-parent-session-id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          Response.json(
            {
              error: {
                type: "arena_compaction_required",
                message: "private-model supports 65536 tokens",
                limit: 65536,
              },
            },
            { status: 413, headers: { "x-model-limit": "65536" } },
          ),
        telemetry: { rawChunk: (_metadata, chunk) => chunks.push(chunk) },
      },
    )
    const expected = { error: { message: "Arena request needs compaction", type: "arena_compaction_required" } }
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual(expected)
    expect(chunks).toEqual([JSON.stringify(expected)])
    expect(response.headers.get("x-model-limit")).toBeNull()
  })

  test("forwards only the engine's compaction offer to the control plane", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const forwarded: (string | null)[] = []
    for (const value of ["auto", "anything-else", undefined]) {
      const sent = request()
      if (value) sent.headers.set("x-arena-compaction", value)
      await proxy(sent, registry, {
        upstream: "https://unit.invalid",
        fetch: async (_input, init) => {
          forwarded.push(new Headers(init?.headers).get("x-arena-compaction"))
          return Response.json({ choices: [] })
        },
      })
    }
    expect(forwarded).toEqual(["auto", null, null])
  })

  test("preserves output exhaustion when OpenRouter labels an unfinished call as tool_calls", () => {
    for (const reason of ["length", "max_tokens", "max_output_tokens"]) {
      expect(
        sanitizePayload(
          { choices: [{ finish_reason: "tool_calls", native_finish_reason: reason, delta: {} }] },
          "generation",
        ),
      ).toEqual({
        choices: [{ finish_reason: "length", delta: {} }],
      })
    }
    expect(
      sanitizePayload(
        { choices: [{ finish_reason: "tool_calls", native_finish_reason: "tool_use", delta: {} }] },
        "generation",
      ),
    ).toEqual({
      choices: [{ finish_reason: "tool_calls", delta: {} }],
    })
  })

  test.each([
    { name: "incomplete at cap", args: '{"content":"partial', tokens: 4096, limit: 4096, finish: "length", calls: 0 },
    {
      name: "incomplete above cap",
      args: '{"content":"partial',
      tokens: 4097,
      limit: 4096,
      finish: "length",
      calls: 0,
    },
    { name: "valid at cap", args: '{"content":"complete"}', tokens: 4096, limit: 4096, finish: "tool-calls", calls: 1 },
    {
      name: "malformed below cap",
      args: '{"content":"partial',
      tokens: 4095,
      limit: 4096,
      finish: "tool-calls",
      calls: 1,
    },
    {
      name: "missing usage",
      args: '{"content":"partial',
      tokens: undefined,
      limit: 4096,
      finish: "tool-calls",
      calls: 1,
    },
    {
      name: "missing request cap",
      args: '{"content":"partial',
      tokens: 4096,
      limit: undefined,
      finish: "tool-calls",
      calls: 1,
    },
  ])(
    "classifies fragmented tool cutoff before the SDK flushes: $name",
    async ({ args, tokens, limit, finish, calls }) => {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "write-1", type: "function", function: { name: "write", arguments: args } },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", native_finish_reason: "tool_calls" }] },
        {
          choices: [],
          ...(tokens === undefined
            ? {}
            : { usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: tokens + 10 } }),
        },
      ]
      const model = createOpenRouter({
        apiKey: "test",
        fetch: async (_input, init) =>
          proxy(
            new Request("http://arena.invalid/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Session-Id": "session-root",
                "x-arena-request-id": requestID,
              },
              body: init?.body,
            }),
            registry,
            {
              upstream: "https://unit.invalid",
              fetch: async () => {
                const bytes = new TextEncoder().encode(
                  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
                )
                let offset = 0
                return new Response(
                  new ReadableStream<Uint8Array>({
                    pull(controller) {
                      if (offset === bytes.length) return controller.close()
                      controller.enqueue(bytes.slice(offset, offset + 1))
                      offset++
                    },
                  }),
                  { headers: { "Content-Type": "text/event-stream" } },
                )
              },
            },
          ),
      }).chat("contestant")
      const result = await model.doStream({ prompt: [], maxOutputTokens: limit })
      const parts = []
      for await (const part of result.stream) parts.push(part)
      expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(calls)
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ finishReason: { unified: finish } })
      expect(parts.filter((part) => part.type === "error")).toEqual([])
    },
  )

  test.each([1, 4096])(
    "reads SSE lines split across %i-byte chunks",
    async (chunkSize) => {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      const content = chunkSize === 1 ? "héllo 🌍" : "code🌍".repeat(8000)
      const payload = {
        id: "private-id",
        model: "private-model",
        choices: [{ delta: { content }, finish_reason: "stop" }],
      }
      const bytes = new TextEncoder().encode(`: keepalive\n\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]`)
      let offset = 0
      let completed = 0
      const recorded: string[] = []
      const response = await proxy(request(), registry, {
        upstream: "https://unit.invalid",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset === bytes.length) {
                  controller.close()
                  return
                }
                const end = Math.min(offset + chunkSize, bytes.length)
                controller.enqueue(bytes.slice(offset, end))
                offset = end
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        telemetry: {
          rawChunk: (_metadata, chunk) => recorded.push(chunk),
          complete: () => {
            completed++
          },
        },
      })

      const body = await response.text()
      expect(body).toContain(JSON.stringify(payload.choices))
      expect(body).toEndWith("data: [DONE]\n\n")
      expect(body).not.toContain("private-")
      expect(recorded.join("")).toBe(body)
      expect(completed).toBe(1)
    },
    2000,
  )

  test("records a refused upstream response as a failed generation", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const calls: string[] = []
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () => Response.json({ error: { message: "provider/hidden-model failed" } }, { status: 500 }),
      telemetry: {
        complete: () => {
          calls.push("complete")
        },
        error: () => {
          calls.push("error")
        },
      },
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
    })
    expect(calls).toEqual(["error"])
  })

  test("records a non-streamed content-filter finish as a failed generation and keeps its partial answer", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const calls: string[] = []
    const chunks: string[] = []
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        Response.json({
          id: "upstream-1",
          provider: "Alibaba",
          choices: [{ message: { content: "partial answer" }, finish_reason: "content_filter" }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      telemetry: {
        rawChunk: (_metadata, chunk) => void chunks.push(chunk),
        complete: () => void calls.push("complete"),
        error: () => void calls.push("error"),
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { type: "content_filter", message: "A content filter blocked this response." },
    })
    expect(calls).toEqual(["error"])
    const raw = chunks.join("")
    expect(raw).toContain("partial answer")
    expect(raw).toContain("prompt_tokens")
    expect(raw).not.toContain("Alibaba")
  })

  test("records a refusal named only by the native finish reason under the content_filter finish", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const chunks: string[] = []
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: "partial" }, finish_reason: "stop", native_finish_reason: "content_filter" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      telemetry: { rawChunk: (_metadata, chunk) => void chunks.push(chunk) },
    })
    expect(response.status).toBe(400)
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
      {
        choices: [{ message: { content: "partial" }, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
    ])
  })

  test("records a non-streamed content_filter error as a failed generation and keeps its usage", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const calls: string[] = []
    const chunks: string[] = []
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        Response.json({
          provider: "Alibaba",
          error: { type: "content_filter", message: "private policy detail" },
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      telemetry: {
        rawChunk: (_metadata, chunk) => void chunks.push(chunk),
        complete: () => void calls.push("complete"),
        error: () => void calls.push("error"),
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { type: "content_filter", message: "A content filter blocked this response." },
    })
    expect(calls).toEqual(["error"])
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
      {
        id: expect.stringMatching(/^gen_/),
        choices: [{ index: 0, message: {}, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
    ])
  })

  test("keeps the usage the service sends with a filtered complete response, and none of it reaches the model call", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const chunks: string[] = []
    const failures: unknown[] = []
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        Response.json(
          {
            error: { type: "content_filter", message: "A content filter blocked this response." },
            usage: { prompt_tokens: 12, completion_tokens: 4 },
            choices: [{ message: { content: "must not be recorded" }, finish_reason: "content_filter" }],
          },
          { status: 400 },
        ),
      telemetry: {
        rawChunk: (_metadata, chunk) => void chunks.push(chunk),
        error: (_metadata, _error, _at, failure) => void failures.push(failure),
      },
    })
    expect(response.status).toBe(400)
    // Byte-for-byte the refusal Core treats as permanent: nothing for a retry or a pending tool to act on.
    expect(await response.json()).toEqual({
      error: { type: "content_filter", message: "A content filter blocked this response." },
    })
    expect(failures).toEqual([{ phase: "http", kind: "content_filter" }])
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
      {
        id: expect.stringMatching(/^gen_/),
        choices: [{ index: 0, message: {}, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
    ])
  })

  test("keeps usage arriving with or after a filtered stream's finish for the failed generation", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const calls: string[] = []
    const chunks: string[] = []
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        new Response(
          'data: {"id":"upstream-1","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n' +
            'data: {"id":"upstream-1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7}}\n\n' +
            "data: [DONE]\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      telemetry: {
        rawChunk: (_metadata, chunk) => void chunks.push(chunk),
        complete: () => {
          calls.push("complete")
          settle()
        },
        error: () => {
          calls.push("error")
          settle()
        },
      },
    })
    expect(response.status).toBe(200)
    await response.text()
    await Promise.race([settled, Bun.sleep(6_000)])
    expect(calls).toEqual(["error"])
    expect(chunks.join("")).toContain("prompt_tokens")
  })

  test("tells a wait on the user's network or sign-in apart from a refusing provider", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const errors: unknown[] = []
    const answer = async (status: number, body: unknown) =>
      proxy(request(), registry, {
        upstream: "https://unit.invalid",
        fetch: async () => Response.json(body, { status }),
        telemetry: { error: (_metadata, error) => void errors.push(error) },
      })
    await answer(503, { error: { message: "Arena network is unavailable", type: "arena_network_unavailable" } })
    await answer(401, { error: { message: "Sign in again", type: "arena_session_rejected" } })
    await answer(503, { error: { message: "overloaded" } })
    await answer(401, { error: { message: "invalid key" } })
    expect(errors.map((error) => (error instanceof ArenaWaitError ? error.wait : "provider"))).toEqual([
      "network",
      "sign-in",
      "provider",
      "provider",
    ])
  })

  test("records which kind of engine request a generation is", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const kinds: unknown[] = []
    for (const kind of ["utility", "generation", "bogus"]) {
      const incoming = request()
      incoming.headers.set("x-arena-generation-classification", kind)
      await proxy(incoming, registry, {
        upstream: "https://unit.invalid",
        fetch: async () => Response.json({ choices: [] }),
        telemetry: { start: (metadata) => void kinds.push(metadata.requestKind) },
      })
    }
    expect(kinds).toEqual(["utility", "generation", undefined])
  })

  test("maps only known pre-header connection failures to a neutral retryable response", async () => {
    for (const code of ["ConnectionRefused", "ECONNREFUSED", "ECONNRESET"]) {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      let recorded = 0
      const response = await proxy(request(), registry, {
        upstream: "https://unit.invalid",
        fetch: async () => {
          throw transportError(code)
        },
        telemetry: {
          error: () => {
            recorded++
          },
        },
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
      })
      expect(recorded).toBe(1)
    }
  })

  test("records that a stream ended while its response is still being saved", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const response = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }),
      telemetry: { complete: () => new Promise<void>(() => {}) },
    })
    const reader = response.body!.getReader()
    void (async () => {
      while (!(await reader.read()).done) {
        // Drain until the stream waits on the save.
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const progress = streamProgress("session-root")
    expect(progress).toMatchObject({ chunks: 1 })
    expect(progress).toHaveProperty("endedMsAgo")
    expect(progress).toHaveProperty("savingMsAgo")
    expect(progress).not.toHaveProperty("savedMsAgo")
    expect(progress).not.toHaveProperty("closedMsAgo")
  })

  test("classifies a real socket reset before response headers", async () => {
    const server = createServer((socket) => socket.once("data", () => socket.resetAndDestroy()))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      const port = (server.address() as AddressInfo).port
      const response = await proxy(request(), registry, {
        upstream: `http://127.0.0.1:${port}`,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("does not retry aborted, unrelated, or post-header failures", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const aborted = new AbortController()
    aborted.abort()
    const abortResponse = await proxy(request(aborted.signal), registry, {
      upstream: "https://unit.invalid",
      fetch: async () => {
        throw transportError("ECONNRESET")
      },
    })
    expect(abortResponse.status).toBe(400)

    const unknownResponse = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () => {
        throw new TypeError("unknown failure")
      },
    })
    expect(unknownResponse.status).toBe(400)

    let fetched = false
    const telemetryResponse = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () => {
        fetched = true
        return Response.json({ ok: true })
      },
      telemetry: {
        start: () => {
          throw transportError("ECONNRESET")
        },
      },
    })
    expect(telemetryResponse.status).toBe(400)
    expect(fetched).toBe(false)

    const bodyResponse = await proxy(request(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(transportError("ECONNRESET"))
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    })
    expect(bodyResponse.status).toBe(400)
  })

  test("words a used-up single-agent allowance without the control plane's text", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const response = await proxy(
      new Request("http://arena.invalid/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-child",
          "x-parent-session-id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          Response.json({ error: "untrusted control plane text", code: singleAgentAllowanceCode }, { status: 403 }),
      },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(singleAgentAllowanceError())
  })

  test("preserves a temporary payment failure for a child session", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let artifact = ""
    let status: number | undefined
    const response = await proxy(
      new Request("http://arena.invalid/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-child",
          "x-parent-session-id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async (_url, init) => {
          expect(new Headers(init?.headers).get("X-Arena-Assignment-ID")).toBe(assignment.assignmentID)
          return Response.json(
            { error: { code: "arena_temporary_budget", message: "untrusted extra text" } },
            {
              status: 402,
              headers: { "retry-after": "60" },
            },
          )
        },
        telemetry: {
          response: (value) => {
            status = value.status
          },
          rawChunk: (_metadata, chunk) => {
            artifact += chunk
          },
        },
      },
    )
    expect(status).toBe(402)
    expect(artifact).toContain("arena_temporary_budget")
    expect(response.headers.get("retry-after")).toBe("60")
    const body = await response.text()
    expect(body).toContain("arena_temporary_budget")
    expect(body).not.toContain("untrusted")
  })

  test("inherits a root assignment for child sessions and rejects unaffiliated sessions", () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    expect(registry.resolve("session-root")).toBe(assignment)
    expect(registry.resolve("session-child", "session-root")).toBe(assignment)
    expect(registry.resolve("session-child")).toBe(assignment)
    expect(() => registry.resolve("unknown")).toThrow("not assigned")
  })

  test("keeps the placeholder model and overwrites reasoning policy", () => {
    const routed = { ...assignment }
    const source = {
      model: "contestant",
      messages: [],
      reasoning: { effort: "low" },
      provider: { order: ["attacker-selected-provider"] },
      stream: true,
    }
    expect(rewriteBody(source, routed)).toEqual({
      model: "contestant",
      messages: [],
      reasoning: { effort: "high" },
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(source.model).toBe("contestant")
    expect(() => rewriteBody({ model: "provider/model" }, routed)).toThrow("unexpected contestant transport model")
  })

  test("accepts the Medium transport model and enforces xhigh reasoning", () => {
    const routed = { ...assignment, modelSize: "medium" as const }
    expect(rewriteBody({ model: "medium", messages: [], reasoning: { effort: "high" } }, routed)).toMatchObject({
      model: "medium",
      reasoning: { effort: "xhigh" },
      stream_options: { include_usage: true },
    })
    expect(() => rewriteBody({ model: "contestant" }, routed)).toThrow("unexpected contestant transport model")
  })

  test("removes response identity fields without corrupting nested tool arguments", () => {
    const payload = sanitizePayload(
      {
        id: "provider-generation",
        model: "provider/hidden-model",
        provider: "example-provider",
        openrouter_metadata: {
          endpoints: { available: [{ provider: "example-provider", selected: true }] },
        },
        choices: [{ delta: { tool_calls: [{ function: { arguments: '{"model":"domain-value"}' } }] } }],
      },
      "gen_opaque",
    ) as Record<string, unknown>
    expect(payload.id).toBe("gen_opaque")
    expect(payload).not.toHaveProperty("model")
    expect(payload).not.toHaveProperty("provider")
    expect(payload).not.toHaveProperty("openrouter_metadata")
    expect(JSON.stringify(payload)).toContain("domain-value")
  })

  test("routes and sanitizes an OpenRouter event stream", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let outbound: Record<string, unknown> | undefined
    let classification: string | undefined
    let observedRequestID: string | undefined
    let forwardedClassification: string | null | undefined
    let forwardedRequestID: string | null | undefined
    let forwardedMetadata: string | null | undefined
    let forwardedAssignmentID: string | null | undefined
    let forwardedScopeID: string | null | undefined
    let forwardedGenerationID: string | null | undefined
    let forwardedLegacyCredential: string | null | undefined
    const response = await proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-root",
          "x-arena-request-id": requestID,
          "x-arena-generation-classification": "compaction",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async (_input, init) => {
          outbound = JSON.parse(String(init?.body)) as Record<string, unknown>
          forwardedClassification = new Headers(init?.headers).get("x-arena-generation-classification")
          forwardedRequestID = new Headers(init?.headers).get("x-arena-request-id")
          forwardedMetadata = new Headers(init?.headers).get("x-openrouter-metadata")
          forwardedAssignmentID = new Headers(init?.headers).get("x-arena-assignment-id")
          forwardedScopeID = new Headers(init?.headers).get("x-arena-scope-id")
          forwardedGenerationID = new Headers(init?.headers).get("x-arena-generation-id")
          forwardedLegacyCredential = new Headers(init?.headers).get("x-arena-assignment")
          return new Response(
            `data: {"id":"raw-id","model":"provider/hidden-model","openrouter_metadata":{"endpoints":{"available":[{"provider":"hidden","selected":true}]}},"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n`,
            {
              headers: {
                "content-type": "text/event-stream",
                "x-openrouter-model": "provider/hidden-model",
              },
            },
          )
        },
        telemetry: {
          start: (metadata) => {
            classification = metadata.classification
            observedRequestID = metadata.requestID
          },
        },
      },
    )

    expect(outbound).toMatchObject({ model: "contestant", reasoning: { effort: "high" } })
    expect(classification).toBe("compaction")
    expect(observedRequestID).toBe(requestID)
    expect(forwardedClassification).toBeNull()
    expect(forwardedRequestID).toBeNull()
    expect(forwardedMetadata).toBe("enabled")
    expect(forwardedAssignmentID).toBe("opaque-assignment")
    expect(forwardedScopeID).toBe("turn-a")
    expect(forwardedGenerationID).toMatch(/^gen_[a-f0-9]{32}$/)
    expect(forwardedLegacyCredential).toBeNull()
    expect(response.headers.get("x-openrouter-model")).toBeNull()
    const text = await response.text()
    expect(text).toContain("hello")
    expect(text).not.toContain("provider/hidden-model")
    expect(text).not.toContain("hidden")
    expect(text).toContain(forwardedGenerationID!)
  })

  test("records interrupted streams when the downstream consumer cancels", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let sourceCancelled = false
    let completed = 0
    const errors: unknown[] = []
    const response = await proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: {"id":"raw-id","model":"provider/hidden-model","choices":[{"delta":{"content":"hello"}}]}\n\n`,
                  ),
                )
              },
              cancel() {
                sourceCancelled = true
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        telemetry: {
          complete: () => {
            completed++
          },
          error: (_metadata, error) => {
            errors.push(error)
          },
        },
      },
    )

    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel(new Error("consumer stopped"))

    expect(sourceCancelled).toBe(true)
    expect(completed).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe("Arena contestant stream was cancelled")
  })

  test("records upstream stream failures without exposing their details downstream", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const errors: unknown[] = []
    const chunks: string[] = []
    const response = await proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (() => {
                let first = true
                return (controller: ReadableStreamDefaultController<Uint8Array>) => {
                  if (first) {
                    first = false
                    controller.enqueue(
                      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
                    )
                    return
                  }
                  controller.error(new Error("failed at provider/hidden-model"))
                }
              })(),
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        telemetry: {
          rawChunk: (_metadata, chunk) => chunks.push(chunk),
          error: (_metadata, error) => {
            errors.push(error)
          },
        },
      },
    )

    const body = await response.text()
    expect(body).toContain("hello")
    expect(body).toContain('"code":"server_error"')
    expect(body).not.toContain("Arena contestant stream failed")
    expect(body).not.toContain("provider/hidden-model")
    expect(chunks.join("")).toContain("hello")
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("Provider response stream failed")
  })

  test("does not retry a stream read failure after cancellation", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const aborted = new AbortController()
    const response = await proxy(request(aborted.signal), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (() => {
              let first = true
              return (controller: ReadableStreamDefaultController<Uint8Array>) => {
                if (first) {
                  first = false
                  controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
                  return
                }
                aborted.abort()
                controller.error(new Error("private cancellation error"))
              }
            })(),
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    await expect(response.text()).rejects.toThrow("Provider response stream failed")
  })

  test("restarts a request after a mid-answer connection break, transient OpenRouter error, or cut-off", async () => {
    const partial = 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'
    // A slow connection ends wherever the bytes ran out, not on an event boundary.
    const cases = [
      { failure: "transport", sent: partial },
      { failure: "openrouter", sent: partial },
      { failure: "cut-off", sent: partial },
      { failure: "cut-off", sent: `${partial}data: {"choi` },
      { failure: "cut-off", sent: partial.slice(0, -1) },
      { failure: "transport", sent: `${partial}data: {"choi` },
      { failure: "transport", sent: partial.slice(0, -1) },
    ] as const
    for (const { failure, sent } of cases) {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      let calls = 0
      const assignmentSet = {
        userId: "user-1",
        scopeID: "turn-a",
        assignments: [
          {
            assignmentID: "opaque-assignment",
            model: {
              displayName: "Hidden Model",
              slug: "provider/hidden-model",
              canonicalSlug: "provider/hidden-model-version",
              contextWindow: 1_000_000,
              routing: { sort: "throughput" },
            },
          },
        ],
      }
      const db = {
        collection: () => ({ find: () => ({ toArray: async () => [assignmentSet] }), replaceOne: async () => ({}) }),
      } as unknown as ArenaDb
      const model = createOpenRouter({
        apiKey: "test-key",
        fetch: async (_input, init) =>
          proxy(
            new Request("http://localhost/arena/openrouter/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Session-Id": "session-root",
                "x-arena-request-id": requestID,
              },
              body: init?.body,
            }),
            registry,
            {
              upstream: "https://control.test/api/openrouter",
              fetch: (input, init) =>
                createArenaService({
                  resolveCaller: async () => ({ id: "user-1" }),
                  db: async () => db,
                  pool: [],
                  openRouterApiKey: "server-secret",
                  fetch: async () => {
                    calls++
                    if (calls > 1) {
                      return new Response(
                        'data: {"choices":[{"index":0,"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n',
                        { headers: { "content-type": "text/event-stream" } },
                      )
                    }
                    return new Response(
                      new ReadableStream<Uint8Array>({
                        pull: (() => {
                          let first = true
                          return (controller: ReadableStreamDefaultController<Uint8Array>) => {
                            if (first) {
                              first = false
                              controller.enqueue(new TextEncoder().encode(sent))
                              return
                            }
                            if (failure === "transport") controller.error(new Error("private network failure"))
                            // A hosting time limit ends the response cleanly, without a finish or [DONE].
                            else if (failure === "cut-off") controller.close()
                            else {
                              controller.enqueue(
                                new TextEncoder().encode(
                                  'data: {"error":{"code":503,"message":"private provider failure"}}\n\n',
                                ),
                              )
                              controller.close()
                            }
                          }
                        })(),
                      }),
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  },
                }).openrouter(new Request(input, init)),
            },
          ),
      }).chat("contestant")

      const answer = await Effect.runPromise(
        Effect.tryPromise({
          try: async () => {
            const result = streamText({ model, prompt: "test", maxRetries: 0 })
            let answer = ""
            for await (const event of result.fullStream) {
              if (event.type === "text-delta") answer += event.text
              if (event.type === "error") throw event.error
            }
            return answer
          },
          catch: (error) => error,
        }).pipe(
          Effect.retry(
            SessionRetry.policy({
              provider: "arena",
              parse: (error) => assistantError(error, ProviderV2.ID.make("arena")),
              set: () => Effect.void,
            }),
          ),
        ),
      )
      expect({ failure, sent, answer, calls }).toEqual({ failure, sent, answer: "complete", calls: 2 })
    }
    // Each case waits out the real first retry backoff.
  }, 30_000)

  test("waits out an offline machine and resumes the same request once the network is back", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let calls = 0
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-a",
      assignments: [
        {
          assignmentID: "opaque-assignment",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            contextWindow: 1_000_000,
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    const db = {
      collection: () => ({ find: () => ({ toArray: async () => [assignmentSet] }), replaceOne: async () => ({}) }),
    } as unknown as ArenaDb
    const service = createArenaService({
      resolveCaller: async () => ({ id: "user-1" }),
      db: async () => db,
      pool: [],
      openRouterApiKey: "server-secret",
      networkUnavailable: (error) => isNetworkUnavailable(error, "openrouter.ai"),
      fetch: async () => {
        calls++
        if (calls === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" }),
          })
        }
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const model = createOpenRouter({
      apiKey: "test-key",
      fetch: async (_input, init) =>
        proxy(
          new Request("http://localhost/arena/openrouter/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Id": "session-root",
              "x-arena-request-id": requestID,
            },
            body: init?.body,
          }),
          registry,
          {
            upstream: "https://control.test/api/openrouter",
            fetch: (input, init) => service.openrouter(new Request(input, init)),
          },
        ),
    }).chat("contestant")

    const messages: string[] = []
    const answer = await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const result = streamText({ model, prompt: "test", maxRetries: 0 })
          let answer = ""
          for await (const event of result.fullStream) {
            if (event.type === "text-delta") answer += event.text
            if (event.type === "error") throw event.error
          }
          return answer
        },
        catch: (error) => error,
      }).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "arena",
            parse: (error) => assistantError(error, ProviderV2.ID.make("arena")),
            set: (info) =>
              Effect.sync(() => {
                messages.push(info.message)
              }),
          }),
        ),
      ),
    )
    expect(answer).toBe("complete")
    expect(calls).toBe(2)
    expect(messages).toEqual([SessionRetry.ARENA_OFFLINE_MESSAGE])
  }, 15_000)

  test("passes the daemon's offline answer through and drops every other 503 body", async () => {
    const offline = { error: { message: "Arena network is unavailable", type: "arena_network_unavailable" } }
    for (const [upstream, expected] of [
      [offline, offline],
      [
        { error: { message: "provider/hidden-model is down", type: "arena_network_unavailable_soon" } },
        { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
      ],
    ] as const) {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      const response = await proxy(request(), registry, {
        upstream: "https://unit.invalid",
        fetch: async () => Response.json(upstream, { status: 503 }),
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual(expected)
    }
  })

  test("passes the daemon's refused-session answer through and drops every other 401 body", async () => {
    const refused = { error: { message: "Arena session was rejected", type: "arena_session_rejected" } }
    for (const [upstream, expected] of [
      [{ error: { message: "Your session expired.", type: "arena_session_rejected" } }, refused],
      [
        { error: { message: "provider/hidden-model: invalid key", type: "invalid_request" } },
        { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
      ],
    ] as const) {
      const registry = new AssignmentRegistry()
      registry.assign("session-root", assignment)
      const response = await proxy(request(), registry, {
        upstream: "https://unit.invalid",
        fetch: async () => Response.json(upstream, { status: 401 }),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(expected)
    }
  })

  test("does not retry permanent errors received mid-answer", () => {
    for (const code of [400, 401, 402, 403, "insufficient_quota", "context_length_exceeded"]) {
      const value = sanitizePayload({ error: { code, message: "private provider details" } }, "generation", true)
      expect(value).toEqual({ error: { message: "Arena contestant request failed", type: "arena_upstream_error" } })
    }
    for (const code of [408, 429, 500, 503, "server_error", undefined]) {
      const value = sanitizePayload({ error: { code, message: "private provider details" } }, "generation", true)
      expect(value).toEqual({
        error: { message: "Provider response stream failed", type: "error", error: { code: "server_error" } },
      })
    }
  })

  test("returns and persists generic upstream errors", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const chunks: string[] = []
    const response = await proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-root",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          Response.json(
            { error: { message: "model provider/hidden-model unavailable at secret-provider" } },
            { status: 503, headers: { "x-provider": "secret-provider" } },
          ),
        telemetry: { rawChunk: (_metadata, chunk) => chunks.push(chunk) },
      },
    )
    const publicBody = await response.text()
    expect(response.status).toBe(503)
    expect(publicBody).not.toContain("provider/hidden-model")
    expect(publicBody).not.toContain("secret-provider")
    expect(chunks.join("\n")).not.toContain("provider/hidden-model")
    expect(chunks.join("\n")).not.toContain("secret-provider")
    expect(chunks.join("\n")).toContain("arena_upstream_error")
  })

  test("does not persist credential-bearing upstream response headers", async () => {
    const registry = new AssignmentRegistry()
    const headerAssignment = registry.assign("session-a", {
      runID: "run-a",
      rootSessionID: "session-a",
      scopeID: "turn-a",
      assignmentID: "opaque-assignment-a",
      telemetry: true,
    })
    let observed: Readonly<Record<string, string>> | undefined
    const response = await proxy(
      new Request("http://arena.local/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-a",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () =>
          new Response('{"choices":[]}', {
            headers: {
              "content-type": "application/json",
              "set-cookie": "session=secret",
              "www-authenticate": "Bearer secret",
              "x-api-key": "secret",
              "x-openrouter-provider": "groq",
            },
          }),
        telemetry: {
          response: ({ headers }) => {
            observed = headers
          },
        },
      },
    )

    expect(response.status).toBe(200)
    expect(observed).not.toHaveProperty("x-openrouter-provider")
    expect(observed).not.toHaveProperty("set-cookie")
    expect(observed).not.toHaveProperty("www-authenticate")
    expect(observed).not.toHaveProperty("x-api-key")
  })

  test("rejects requests without internally generated provenance", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let requested = false
    const response = await proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "session-root" },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: async () => {
          requested = true
          return Response.json({ choices: [] })
        },
      },
    )

    expect(response.status).toBe(400)
    expect(requested).toBe(false)
  })

  test("records phase-split telemetry for dispatched bytes, header timeouts, HTTP refusals, and stream timeouts", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-phase", { ...assignment, rootSessionID: "session-phase", telemetry: true })
    const makeRequest = (signal?: AbortSignal) =>
      new Request("http://arena.local/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-phase",
          "x-arena-request-id": requestID,
        },
        body: JSON.stringify({ model: "contestant", messages: [{ role: "user", content: "hello" }] }),
        signal,
      })

    // 1. Pre-header timeout abort.
    const headerAbort = new AbortController()
    let headerDispatch: { dispatchedAt: Date; requestBytes: number } | undefined
    let headerFailure: { phase: string; kind: string } | undefined
    const headerResponse = await proxy(makeRequest(headerAbort.signal), registry, {
      upstream: "https://unit.invalid",
      fetch: async (_url, init) => {
        headerAbort.abort(new Error("Response headers timed out"))
        throw init?.signal?.reason ?? new Error("aborted")
      },
      telemetry: {
        dispatched: ({ dispatchedAt, requestBytes }) => {
          headerDispatch = { dispatchedAt, requestBytes }
        },
        error: (_metadata, _error, _at, failure) => {
          headerFailure = failure
        },
      },
    })
    expect(headerResponse.status).toBe(400)
    expect(headerDispatch?.dispatchedAt).toBeInstanceOf(Date)
    expect(headerDispatch?.requestBytes).toBeGreaterThan(0)
    expect(headerFailure).toEqual({ phase: "headers", kind: "header_timeout" })

    // 2. Upstream HTTP 500 refusal.
    let httpFailure: { phase: string; kind: string } | undefined
    const httpResponse = await proxy(makeRequest(), registry, {
      upstream: "https://unit.invalid",
      fetch: async () => new Response("upstream failure", { status: 500 }),
      telemetry: {
        error: (_metadata, _error, _at, failure) => {
          httpFailure = failure
        },
      },
    })
    expect(httpResponse.status).toBe(500)
    expect(httpFailure).toEqual({ phase: "http", kind: "http_status" })

    // 3. Mid-stream SSE read timeout cancel.
    const streamAbort = new AbortController()
    let streamFailure: { phase: string; kind: string } | undefined
    const streamResponse = await proxy(makeRequest(streamAbort.signal), registry, {
      upstream: "https://unit.invalid",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {},
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      telemetry: {
        error: (_metadata, _error, _at, failure) => {
          streamFailure = failure
        },
      },
    })
    expect(streamResponse.status).toBe(200)
    streamAbort.abort(new Error("SSE read timed out"))
    await streamResponse.body?.cancel(new Error("SSE read timed out"))
    expect(streamFailure).toEqual({ phase: "stream", kind: "stream_timeout" })
  })
})
