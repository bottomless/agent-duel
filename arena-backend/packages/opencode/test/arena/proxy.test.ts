import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { AssignmentRegistry, proxy, rewriteBody, sanitizePayload, streamProgress } from "../../src/arena/proxy"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { createArenaService } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"

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
      fetch: async () => new Response('data: {"choices":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
      telemetry: { complete: () => new Promise<void>(() => {}) },
    })
    const reader = response.body!.getReader()
    await reader.read()
    void reader.read()
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

  test("signals dispatch immediately after initiating the upstream request", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const events: string[] = []
    let dispatched!: () => void
    const dispatch = new Promise<void>((resolve) => {
      dispatched = resolve
    })
    let release!: (response: Response) => void
    const upstream = new Promise<Response>((resolve) => {
      release = resolve
    })
    const pending = proxy(
      new Request("http://localhost/arena/openrouter/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-root",
          "x-arena-request-id": requestID,
          "x-arena-generation-classification": "generation",
        },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
      registry,
      {
        upstream: "https://unit.invalid",
        fetch: () => {
          events.push("fetch")
          return upstream
        },
        onDispatch: () => {
          events.push("dispatch")
          dispatched()
        },
      },
    )

    await dispatch
    expect(events).toEqual(["fetch", "dispatch"])
    release(Response.json({ choices: [] }))
    expect((await pending).status).toBe(200)
  })

  test("does not treat utility or child generations as the initial contestant dispatch", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let dispatched = 0
    const request = (sessionID: string, classification: string, parentSessionID?: string) =>
      proxy(
        new Request("http://localhost/arena/openrouter/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": sessionID,
            ...(parentSessionID ? { "X-Parent-Session-Id": parentSessionID } : {}),
            "x-arena-request-id": requestID,
            "x-arena-generation-classification": classification,
          },
          body: JSON.stringify({ model: "contestant", messages: [] }),
        }),
        registry,
        {
          upstream: "https://unit.invalid",
          fetch: async () => Response.json({ choices: [] }),
          onDispatch: () => dispatched++,
        },
      )

    await request("session-root", "utility")
    await request("session-child", "generation", "session-root")
    expect(dispatched).toBe(0)
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
    expect(rewriteBody(source, routed) as Record<string, unknown>).toEqual({
      model: "contestant",
      messages: [],
      reasoning: { effort: "high" },
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(source.model).toBe("contestant")
    expect(() => rewriteBody({ model: "provider/model" }, routed)).toThrow("unexpected contestant transport model")
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
    expect(body).not.toContain("provider/hidden-model")
    expect(chunks.join("")).toContain("hello")
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("Arena contestant stream failed")
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
    await expect(response.text()).rejects.toThrow("Arena contestant stream failed")
  })

  test("restarts a request after a mid-answer connection break or transient OpenRouter error", async () => {
    for (const failure of ["transport", "openrouter"] as const) {
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
                              controller.enqueue(
                                new TextEncoder().encode(
                                  'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
                                ),
                              )
                              return
                            }
                            if (failure === "transport") controller.error(new Error("private network failure"))
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
              parse: (error) => MessageV2.fromError(error, { providerID: ProviderV2.ID.make("arena") }),
              set: () => Effect.void,
            }),
          ),
        ),
      )
      expect(answer).toBe("complete")
      expect(calls).toBe(2)
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
        error: { message: "Arena contestant stream failed", type: "error", error: { code: "server_error" } },
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
})
