import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import type { ModelPool } from "./pool"
import { createArenaService, type ArenaServiceOptions } from "./service"

// The proxy never samples from the pool; the service still needs one.
const pool: ModelPool = [
  {
    displayName: "GLM 5.2",
    slug: "z-ai/glm-5.2-20260616",
    canonicalSlug: "z-ai/glm-5.2-20260616",
    contextWindow: 1_048_576,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 2.1, completion: 6.6 },
    },
  },
  {
    displayName: "Qwen 3.8 Max",
    slug: "qwen/qwen3.8-max-0902",
    canonicalSlug: "qwen/qwen3.8-max-20260902",
    contextWindow: 1_000_000,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 3, completion: 9 },
    },
  },
  {
    displayName: "Grok 4.6",
    slug: "x-ai/grok-4.6",
    canonicalSlug: "x-ai/grok-4.6-20260810",
    contextWindow: 500_000,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 3, completion: 9 },
    },
  },
]

function openrouter(options: Partial<ArenaServiceOptions> = {}) {
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => {
      throw new Error("The Arena store must not be opened")
    },
    pool,
    openRouterApiKey: "server-secret",
    fetch: async () => {
      throw new Error("OpenRouter must not be contacted")
    },
    ...options,
  }).openrouter
}

/**
 * Answers the two collections the proxy touches. `assignmentSets` decides
 * which sets a find returns; `recordMetrics` sees each metrics document the
 * proxy writes.
 */
function fakeDb(input: {
  readonly assignmentSets: (filter: Record<string, unknown>) => readonly unknown[]
  readonly recordMetrics?: (document: Record<string, unknown>) => void
}) {
  return {
    collection: (name: string) => {
      if (name === "arenaAssignmentSets") {
        return {
          find: (filter: Record<string, unknown>) => ({
            toArray: async () => [...input.assignmentSets(filter)],
          }),
        }
      }
      if (name === "arenaAssignmentGenerationMetrics") {
        return {
          replaceOne: async (_filter: unknown, document: Record<string, unknown>) => {
            input.recordMetrics?.(document)
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
          },
        }
      }
      throw new Error(`Unexpected Arena collection: ${name}`)
    },
  } as unknown as ArenaDb
}

describe("OpenRouter proxy", () => {
  test("rejects a request before contacting OpenRouter when the session is invalid", async () => {
    let contacted = false
    const response = await openrouter({
      resolveCaller: async () => undefined,
      fetch: async () => {
        contacted = true
        return new Response()
      },
    })(new Request("https://control.test/api/openrouter/api/v1/models"))

    expect(response.status).toBe(401)
    expect(contacted).toBe(false)
  })

  test("rejects a request without assignment scope before contacting OpenRouter", async () => {
    let contacted = false
    const response = await openrouter({
      fetch: async () => {
        contacted = true
        return Response.json({ choices: [] })
      },
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer desktop-session",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "provider/chosen-by-client", messages: [] }),
      }),
    )

    expect(response.status).toBe(400)
    expect(contacted).toBe(false)
  })

  test("does not expose arbitrary OpenRouter paths", async () => {
    const response = await openrouter()(new Request("https://control.test/api/openrouter/oauth/callback"))

    expect(response.status).toBe(404)
  })

  test("rejects every request missing assignment headers", async () => {
    let contacted = false
    const proxy = openrouter({
      fetch: async () => {
        contacted = true
        return Response.json({ choices: [] })
      },
    })
    const invoke = (body: Record<string, unknown>) =>
      proxy(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )

    expect((await invoke({ model: "provider/other", messages: [] })).status).toBe(400)
    expect((await invoke({ model: "minimax/minimax-m2.7", messages: [] })).status).toBe(400)
    expect(contacted).toBe(false)
  })

  test("rejects partial assignment headers without falling through to utility access", async () => {
    let contacted = false
    const response = await openrouter({
      fetch: async () => {
        contacted = true
        return Response.json({ choices: [] })
      },
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "",
        },
        body: JSON.stringify({ model: "minimax/minimax-m2.7", messages: [] }),
      }),
    )

    expect(response.status).toBe(400)
    expect(contacted).toBe(false)
  })

  test("rejects query selectors and malformed JSON", async () => {
    let contacted = false
    const proxy = openrouter({
      fetch: async () => {
        contacted = true
        return Response.json({ choices: [] })
      },
    })
    const request = (url: string, body: BodyInit) =>
      proxy(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      )

    expect(
      (
        await request(
          "https://control.test/api/openrouter/api/v1/chat/completions?preset=other",
          JSON.stringify({ model: "contestant", messages: [] }),
        )
      ).status,
    ).toBe(400)
    expect((await request("https://control.test/api/openrouter/api/v1/chat/completions", '{"model":')).status).toBe(400)
    expect(contacted).toBe(false)
  })

  test("resolves an opaque assignment and removes identity and cost before returning it", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    let recordedMetrics: Record<string, unknown> | undefined
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput", max_price: { prompt: 2, completion: 6 } },
          },
        },
      ],
    }
    const db = fakeDb({
      assignmentSets: () => [assignmentSet],
      recordMetrics: (document) => {
        recordedMetrics = document
      },
    })
    let upstreamFailure: Response | undefined
    const proxy = openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        if (upstreamFailure) return upstreamFailure
        upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
        return Response.json(
          {
            id: "provider-generation",
            model: "provider/hidden-model",
            provider: "hidden-provider",
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.123 },
            choices: [{ message: { content: "done" } }],
          },
          { headers: { "x-openrouter-provider": "hidden-provider" } },
        )
      },
    })
    const invoke = () =>
      proxy(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer desktop-session",
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": "opaque-id",
            "X-Arena-Scope-ID": "turn-1",
            "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
          },
          body: JSON.stringify({ model: "contestant", messages: [], stream: false, max_tokens: 999_999 }),
        }),
      )

    const response = await invoke()
    expect(upstreamBody).toEqual({
      model: "provider/hidden-model",
      messages: [],
      stream: false,
      max_tokens: 999_999,
      reasoning: { effort: "high" },
      provider: { sort: "throughput", max_price: { prompt: 2, completion: 6 } },
      stream_options: { include_usage: true },
    })
    expect(response.headers.get("x-openrouter-provider")).toBeNull()
    const payload = (await response.json()) as Record<string, unknown>
    expect(JSON.stringify(payload)).not.toContain("hidden-model")
    expect(JSON.stringify(payload)).not.toContain("hidden-provider")
    expect(JSON.stringify(payload)).not.toContain("0.123")
    expect(payload.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 })
    expect(recordedMetrics).toMatchObject({
      userId: "user-1",
      scopeID: "turn-1",
      assignmentID: "opaque-id",
      generationID: "gen_00000000000000000000000000000001",
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.123 },
    })
    for (const [source, code] of [
      ["openrouter_in_flight_budget", "arena_temporary_budget"],
      ["openrouter_key_limit", "arena_credit_limit"],
      ["openrouter_credits", "arena_credit_limit"],
      ["unrecognized", "arena_payment_required"],
    ]) {
      upstreamFailure = Response.json(
        {
          error: {
            message: "hidden-model at hidden-provider",
            metadata: { limit_source: source, provider: "hidden-provider", remedy_hint: "private" },
          },
        },
        { status: 402, headers: { "retry-after": "60", "x-openrouter-provider": "hidden-provider" } },
      )
      const failed = await invoke()
      expect(failed.status).toBe(402)
      expect(failed.headers.get("retry-after")).toBe("60")
      expect(failed.headers.get("x-openrouter-provider")).toBeNull()
      const body = await failed.text()
      expect(body).toContain(code!)
      expect(body).not.toMatch(/hidden|private|openrouter/)
    }
    upstreamFailure = new Response("not JSON", { status: 402 })
    expect(await (await invoke()).text()).toContain("arena_payment_required")
  })

  test("does not limit assigned request size", async () => {
    const content = "x".repeat(2 * 1024 * 1024 + 1)
    let upstreamContentLength = 0
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    const db = fakeDb({ assignmentSets: () => [assignmentSet] })
    const response = await openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        const upstream = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
          messages: Array<{ content: string }>
        }
        upstreamContentLength = upstream.messages[0]?.content.length ?? 0
        return Response.json({ choices: [{ message: { content: "done" } }] })
      },
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
        },
        body: JSON.stringify({ model: "contestant", messages: [{ role: "user", content }] }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamContentLength).toBe(content.length)
  })

  test("rejects alternate model and routing selectors and server-side tools on assigned requests", async () => {
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    const db = fakeDb({ assignmentSets: () => [assignmentSet] })
    let contacted = false
    const proxy = openrouter({
      db: async () => db,
      fetch: async () => {
        contacted = true
        return Response.json({ choices: [] })
      },
    })
    const invoke = (extra: Record<string, unknown>) =>
      proxy(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": "opaque-id",
            "X-Arena-Scope-ID": "turn-1",
          },
          body: JSON.stringify({ model: "contestant", messages: [], ...extra }),
        }),
      )

    for (const extra of [
      { models: ["other/model"] },
      { route: "fallback" },
      { plugins: [{ id: "web" }] },
      { tools: [{ type: "web_search" }] },
    ]) {
      expect((await invoke(extra)).status).toBe(400)
    }
    expect(contacted).toBe(false)
  })

  test("scrubs identity metadata from assigned event streams", async () => {
    let recordedMetrics: Record<string, unknown> | undefined
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    const db = fakeDb({
      assignmentSets: () => [assignmentSet],
      recordMetrics: (document) => {
        recordedMetrics = document
      },
    })
    const response = await openrouter({
      db: async () => db,
      fetch: async () =>
        new Response(
          [
            "event: hidden-provider",
            'data: {"id":"provider-id","model":"provider/hidden-model","provider":"hidden-provider","choices":[{"delta":{"content":"done"}}]}',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.123},"system_fingerprint":"hidden-fingerprint"}',
            'data: {"error":{"code":503,"message":"private hidden-provider outage"}}',
            'data: {"error":{"code":402,"message":"private hidden-provider billing"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
              "x-openrouter-provider": "hidden-provider",
            },
          },
        ),
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000002",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      }),
    )

    const body = await response.text()
    expect(response.headers.get("x-openrouter-provider")).toBeNull()
    expect(body).toContain('"content":"done"')
    expect(body).toContain('"prompt_tokens":10')
    expect(body).toContain('"type":"arena_retryable_stream_error"')
    expect(body).toContain('"type":"arena_upstream_error"')
    expect(body).not.toContain("provider-id")
    expect(body).not.toContain("hidden-model")
    expect(body).not.toContain("hidden-provider")
    expect(body).not.toContain("hidden-fingerprint")
    expect(body).not.toContain("0.123")
    expect(body).not.toContain("private")
    expect(recordedMetrics).toMatchObject({
      generationID: "gen_00000000000000000000000000000002",
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.123 },
    })
  })

  test("turns an upstream stream break into a safe retryable event", async () => {
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    const db = fakeDb({ assignmentSets: () => [assignmentSet] })
    let first = true
    const response = await openrouter({
      db: async () => db,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (first) {
                first = false
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
                return
              }
              controller.error(new Error("private transport failure"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      }),
    )

    const body = await response.text()
    expect(body).toContain('"content":"partial"')
    expect(body).toContain('"type":"arena_retryable_stream_error"')
    expect(body).not.toContain("private")
  })

  test("rejects cross-account, cross-scope, and incomplete assignment credentials", async () => {
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: {
            displayName: "Hidden Model",
            slug: "provider/hidden-model",
            canonicalSlug: "provider/hidden-model-version",
            routing: { sort: "throughput" },
          },
        },
      ],
    }
    let contacted = 0
    // The assignment ID is not part of the filter: the proxy matches it
    // inside the sets the account and scope select.
    const db = fakeDb({
      assignmentSets: (filter) =>
        filter.userId === assignmentSet.userId && filter.scopeID === assignmentSet.scopeID ? [assignmentSet] : [],
    })
    const invoke = (userId: string, scopeID?: string, assignmentID = "opaque-id") =>
      openrouter({
        resolveCaller: async () => ({ id: userId }),
        db: async () => db,
        fetch: async () => {
          contacted++
          return Response.json({ choices: [] })
        },
      })(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": assignmentID,
            ...(scopeID ? { "X-Arena-Scope-ID": scopeID } : {}),
          },
          body: JSON.stringify({ model: "contestant", messages: [] }),
        }),
      )

    expect((await invoke("user-2", "turn-1")).status).toBe(403)
    expect((await invoke("user-1", "turn-2")).status).toBe(403)
    expect((await invoke("user-1", "turn-1", "other-id")).status).toBe(403)
    expect((await invoke("user-1")).status).toBe(400)
    expect(contacted).toBe(0)
  })
})
