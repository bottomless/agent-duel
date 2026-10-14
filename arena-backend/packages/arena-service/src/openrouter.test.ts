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
  test.each([1, 4096])(
    "reads SSE lines split across %i-byte chunks",
    async (chunkSize) => {
      const content = chunkSize === 1 ? "héllo 🌍" : "code🌍".repeat(8000)
      const payload = {
        id: "private-id",
        model: "private-model",
        choices: [{ delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0, cost_details: { upstream_inference_cost: 0.123 } },
      }
      const bytes = new TextEncoder().encode(`: keepalive\n\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]`)
      let offset = 0
      const metrics: Record<string, unknown>[] = []
      const db = fakeDb({
        assignmentSets: () => [
          {
            userId: "user-1",
            scopeID: "turn-1",
            assignments: [{ assignmentID: "opaque-id", model: pool[0] }],
          },
        ],
        recordMetrics: (document) => metrics.push(document),
      })
      const response = await openrouter({
        db: async () => db,
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
      })(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": "opaque-id",
            "X-Arena-Scope-ID": "turn-1",
            "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
          },
          body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
        }),
      )

      const body = await response.text()
      expect(body).toContain(JSON.stringify(payload.choices))
      expect(body).toEndWith("data: [DONE]")
      expect(body).not.toContain("private-")
      expect(body).not.toContain("cost")
      expect(metrics).toHaveLength(1)
      expect(metrics[0]).toMatchObject({
        generationID: "gen_00000000000000000000000000000001",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, cost: 0, upstreamInferenceCost: 0.123 },
      })
    },
    2000,
  )

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
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              cost: 0,
              cost_details: { upstream_inference_cost: 0.456 },
            },
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
      usage: { promptTokens: 10, completionTokens: 5, cost: 0, upstreamInferenceCost: 0.456 },
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

  test.each([
    ["absent", undefined, undefined],
    ["null", null, undefined],
    ["zero", 0, 0],
    ["negative", -0.1, undefined],
    ["non-numeric", "0.1", undefined],
  ])("keeps only a finite non-negative upstream inference cost when %s", async (_name, upstream, expected) => {
    let recordedMetrics: Record<string, unknown> | undefined
    const db = fakeDb({
      assignmentSets: () => [
        {
          userId: "user-1",
          scopeID: "turn-cost-details",
          assignments: [{ assignmentID: "opaque-id", model: pool[0] }],
        },
      ],
      recordMetrics: (document) => {
        recordedMetrics = document
      },
    })
    const response = await openrouter({
      db: async () => db,
      fetch: async () =>
        Response.json({
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            cost: 0,
            ...(upstream === undefined ? {} : { cost_details: { upstream_inference_cost: upstream } }),
          },
        }),
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-cost-details",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000003",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: false }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ usage: { prompt_tokens: 1, completion_tokens: 1 } })
    const usage = recordedMetrics?.usage as Record<string, unknown>
    if (expected === undefined) expect(usage).not.toHaveProperty("upstreamInferenceCost")
    else expect(usage).toMatchObject({ cost: 0, upstreamInferenceCost: expected })
  })

  test("asks OpenRouter to cache Anthropic prompts and records the cache use", async () => {
    const slug = "anthropic/hidden-model"
    const upstreamBodies: Record<string, unknown>[] = []
    let recordedMetrics: Record<string, unknown> | undefined
    const db = fakeDb({
      assignmentSets: () => [
        {
          userId: "user-1",
          scopeID: "turn-1",
          assignments: [
            {
              assignmentID: "opaque-id",
              model: { displayName: "Hidden Model", slug, canonicalSlug: slug, routing: { sort: "throughput" } },
            },
          ],
        },
      ],
      recordMetrics: (document) => {
        recordedMetrics = document
      },
    })
    const proxy = openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        upstreamBodies.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>)
        return Response.json({
          choices: [{ message: { content: "done" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 80 },
          },
        })
      },
    })
    const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
    const invoke = (route: string, fields: Record<string, unknown> = {}) =>
      proxy(
        new Request(`https://control.test/api/openrouter/api/v1/${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": "opaque-id",
            "X-Arena-Scope-ID": "turn-1",
            "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
          },
          body: JSON.stringify({ model: "contestant", messages: [], tools, stream: false, ...fields }),
        }),
      )

    expect((await invoke("chat/completions")).status).toBe(200)
    expect(recordedMetrics).toMatchObject({ usage: { promptTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 80 } })
    expect((await invoke("responses")).status).toBe(200)
    expect(upstreamBodies.map((body) => body.cache_control)).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }])

    // A body that marks its own breakpoints is forwarded as sent.
    const marker = { type: "ephemeral", ttl: "1h" }
    const messages = [{ role: "user", content: [{ type: "text", text: "hi", cache_control: marker }] }]
    await invoke("chat/completions", { messages })
    expect(upstreamBodies.at(-1)).not.toHaveProperty("cache_control")
    expect(upstreamBodies.at(-1)?.messages).toEqual(messages)
    await invoke("chat/completions", { cache_control: marker })
    expect(upstreamBodies.at(-1)?.cache_control).toEqual(marker)

    // Compaction summaries and titles carry no tools, and no later request reads their prefix.
    for (const fields of [{ tools: undefined }, { tools: [] }]) {
      await invoke("chat/completions", fields)
      expect(upstreamBodies.at(-1)).not.toHaveProperty("cache_control")
    }
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
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0,"cost_details":{"upstream_inference_cost":0.789}},"system_fingerprint":"hidden-fingerprint"}',
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
      usage: { promptTokens: 10, completionTokens: 5, cost: 0, upstreamInferenceCost: 0.789 },
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

  test("answers an unreadable upstream body with a 502", async () => {
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
      fetch: async () => new Response("not JSON", { headers: { "content-type": "application/json" } }),
    })(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: false }),
      }),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: { message: "OpenRouter request failed" } })
  })

  test("answers an offline machine with the network body only where the service runs locally", async () => {
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
    const failure = new Error("Unable to connect. Is the computer able to access the url?")
    const send = (options: Partial<ArenaServiceOptions>) =>
      openrouter({
        db: async () => db,
        fetch: async () => {
          throw failure
        },
        ...options,
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

    const local = await send({ networkUnavailable: async (error) => error === failure })
    expect(local.status).toBe(503)
    expect(await local.json()).toEqual({
      error: { message: "Arena network is unavailable", type: "arena_network_unavailable" },
    })
    expect((await send({ networkUnavailable: async () => false })).status).toBe(502)
    expect((await send({})).status).toBe(502)
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
