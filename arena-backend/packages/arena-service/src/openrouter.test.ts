import { describe, expect, spyOn, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { defaultPool, mediumModel } from "./default-pool"
import { probeRouting } from "./openrouter"
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
  test.each(["done", "eof", "unterminated-eof"])(
    "flushes buffered reasoning at %s without a finish event",
    async (ending) => {
      const db = fakeDb({
        assignmentSets: () => [
          { userId: "user-1", scopeID: "turn-1", assignments: [{ assignmentID: "opaque-id", model: pool[0] }] },
        ],
      })
      const delta = {
        reasoning_details: [{ type: "reasoning.text", text: "Private thought", signature: "signature", index: 0 }],
      }
      const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}`
      let body: Record<string, unknown> | undefined
      const proxy = openrouter({
        db: async () => db,
        fetch: async (_input, init) => {
          body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
          return new Response(chunk + (ending === "done" ? "\n\ndata: [DONE]" : ending === "eof" ? "\n\n" : ""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const invoke = (messages: unknown[]) =>
        proxy(
          new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Arena-Assignment-ID": "opaque-id",
              "X-Arena-Scope-ID": "turn-1",
            },
            body: JSON.stringify({ model: "contestant", messages, stream: true }),
          }),
        )
      const text = await (await invoke([])).text()
      expect(text).not.toContain("Private thought")
      expect(text).not.toContain("signature")
      const events = text
        .split("\n\n")
        .map((event) => event.trim())
        .filter(Boolean)
      const details = events
        .filter((event) => event !== "data: [DONE]")
        .flatMap((event) => {
          const value = JSON.parse(event.slice(6)) as { choices: { delta: { reasoning_details: unknown[] } }[] }
          return value.choices.flatMap((choice) => choice.delta.reasoning_details)
        })
      expect(details.filter((detail) => (detail as { type: string }).type === "reasoning.encrypted")).toHaveLength(1)
      if (ending === "done") expect(events.at(-1)).toBe("data: [DONE]")
      await (await invoke([{ role: "assistant", reasoning_details: details }])).text()
      expect(body?.messages).toEqual([{ role: "assistant", reasoning: "Private thought", ...delta }])
    },
  )

  test.each([false, true])(
    "redacts nested Responses reasoning and restores it for continuation (stream=%s)",
    async (stream) => {
      const db = fakeDb({
        assignmentSets: () => [
          {
            userId: "user-1",
            scopeID: "turn-1",
            assignments: [{ assignmentID: "opaque-id", model: pool[0] }],
          },
        ],
      })
      const item = {
        type: "reasoning",
        id: "rs_private",
        summary: [{ type: "summary_text", text: "private deliberation" }],
        encrypted_content: "private signature",
      }
      const upstream = { id: "private-response", model: "private-model", output: [item] }
      let body: Record<string, unknown> | undefined
      const proxy = openrouter({
        db: async () => db,
        fetch: async (_input, init) => {
          body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
          return stream
            ? new Response(
                `data: ${JSON.stringify({ type: "response.completed", response: upstream })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              )
            : Response.json(upstream)
        },
      })
      const invoke = (input: unknown[]) =>
        proxy(
          new Request("https://control.test/api/openrouter/api/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Arena-Assignment-ID": "opaque-id",
              "X-Arena-Scope-ID": "turn-1",
            },
            body: JSON.stringify({ model: "contestant", input, stream }),
          }),
        )
      const response = await invoke([])
      const text = await response.text()
      expect(text).not.toContain("private")
      expect(text).toContain("Thinking redacted")
      const payload = JSON.parse(stream ? text.split("\n")[0]!.slice(6) : text) as {
        output: unknown[]
        response: { output: unknown[] }
      }
      await (await invoke(stream ? payload.response.output : payload.output)).text()
      expect(body?.input).toEqual([item])
    },
  )

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
      expect(body).toEndWith("data: [DONE]\n\n")
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
    expect((await invoke({ model: "qwen/qwen3.8-27b", messages: [] })).status).toBe(400)
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
        body: JSON.stringify({ model: "qwen/qwen3.8-27b", messages: [] }),
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
      session_id: "opaque-id",
      prompt_cache_key: "opaque-id",
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
      provider: "hidden-provider",
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

  test("logs why OpenRouter refused a contestant request, and keeps the client's answer neutral", async () => {
    const db = fakeDb({
      assignmentSets: () => [
        {
          userId: "user-1",
          scopeID: "turn|38:chat|30:ses_refused|1:4",
          assignments: [{ assignmentID: "opaque-id", model: pool[2] }],
        },
      ],
    })
    let upstreamFailure: Response = new Response()
    const invoke = openrouter({ db: async () => db, fetch: async () => upstreamFailure })
    const request = () =>
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn|38:chat|30:ses_refused|1:4",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000009",
        },
        body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
      })
    const logged: Array<{ readonly message: unknown; readonly detail: unknown }> = []
    const error = spyOn(console, "error").mockImplementation((message: unknown, detail: unknown) => {
      logged.push({ message, detail })
    })
    const lastRecord = () => JSON.parse(String(logged.at(-1)?.detail))
    try {
      upstreamFailure = Response.json(
        {
          error: {
            code: 400,
            message: "Provider returned error",
            metadata: { provider_name: "xAI", raw: `{"error":"Too many images: ${"x".repeat(10_000)}"}` },
          },
        },
        { status: 400 },
      )
      const refused = await invoke(request())
      expect(refused.status).toBe(400)
      expect(await refused.text()).toBe(
        JSON.stringify({ error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }),
      )
      expect(logged).toHaveLength(1)
      expect(logged[0]?.message).toBe("[arena-service] OpenRouter refused a contestant request")
      const record = lastRecord()
      expect(record).toMatchObject({
        scopeID: "turn|38:chat|30:ses_refused|1:4",
        assignmentID: "opaque-id",
        generationID: "gen_00000000000000000000000000000009",
        userId: "user-1",
        model: "x-ai/grok-4.6",
        status: 400,
      })
      expect(String(record.upstream)).toContain("Provider returned error")
      expect(String(record.upstream)).toContain("Too many images")
      expect(String(logged[0]?.detail).length).toBeLessThan(5_000)

      upstreamFailure = new Response("upstream gateway text", { status: 400 })
      await invoke(request())
      expect(lastRecord()).toMatchObject({ status: 400, upstream: "upstream gateway text" })

      upstreamFailure = Response.json(
        { error: { message: "Insufficient credits", metadata: { limit_source: "openrouter_credits" } } },
        { status: 402 },
      )
      const payment = await invoke(request())
      expect(await payment.text()).toContain("arena_credit_limit")
      expect(lastRecord()).toMatchObject({ status: 402 })
      expect(String(lastRecord().upstream)).toContain("openrouter_credits")
    } finally {
      error.mockRestore()
    }
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

  test("keeps each side of a turn on one provider and its cache, and records that provider privately", async () => {
    const upstreamBodies: Record<string, unknown>[] = []
    const recorded: Record<string, unknown>[] = []
    const db = fakeDb({
      assignmentSets: () => [
        { userId: "user-1", scopeID: "turn-1", assignments: [{ assignmentID: "opaque-id", model: pool[0] }] },
      ],
      recordMetrics: (document) => recorded.push(document),
    })
    const proxy = openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        upstreamBodies.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>)
        return new Response(
          `data: ${JSON.stringify({
            id: "private-id",
            provider: "Private Provider",
            choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const response = await proxy(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
        },
        // A client's own keys would let it steer the routing of a hidden model.
        body: JSON.stringify({
          model: "contestant",
          messages: [],
          stream: true,
          session_id: "client",
          prompt_cache_key: "client",
        }),
      }),
    )

    expect(await response.text()).not.toContain("Private Provider")
    expect(upstreamBodies[0]).toMatchObject({ session_id: "opaque-id", prompt_cache_key: "opaque-id" })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ provider: "Private Provider", finishReason: "stop" })
  })

  test("forwards a keep-alive ping only for Claude, and answers every model the same way", async () => {
    const claude = {
      displayName: "Hidden Model",
      slug: "anthropic/hidden-model",
      canonicalSlug: "anthropic/hidden-model",
      routing: { sort: "throughput" },
    }
    const upstreamBodies: Record<string, unknown>[] = []
    const recorded: Record<string, unknown>[] = []
    const info = spyOn(console, "info").mockImplementation(() => {})
    const db = fakeDb({
      assignmentSets: () => [
        {
          userId: "user-1",
          scopeID: "turn-1",
          assignments: [
            { assignmentID: "claude-side", model: claude },
            { assignmentID: "other-side", model: pool[0] },
          ],
        },
      ],
      recordMetrics: (document) => recorded.push(document),
    })
    const proxy = openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        upstreamBodies.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>)
        return new Response(
          `data: ${JSON.stringify({
            provider: "Private Provider",
            choices: [{ delta: { content: "o" }, finish_reason: "length" }],
            usage: { prompt_tokens: 20_000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 19_990 } },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
    const ping = (assignmentID: string, route = "chat/completions") =>
      proxy(
        new Request(`https://control.test/api/openrouter/api/v1/${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": assignmentID,
            "X-Arena-Scope-ID": "turn-1",
            "X-Arena-Keep-Alive": "1",
          },
          body: JSON.stringify({
            model: "contestant",
            messages: [{ role: "user", content: "hi" }],
            tools,
            stream: true,
            max_tokens: 1,
            max_completion_tokens: 32_000,
          }),
        }),
      )

    try {
      const answers = [await ping("claude-side"), await ping("other-side"), await ping("claude-side", "responses")]
      for (const answer of answers) {
        expect(answer.status).toBe(204)
        expect(answer.headers.get("X-Arena-Keep-Alive")).toBe("1")
        expect(await answer.text()).toBe("")
      }
      // Only the Claude ping on the route Claude sides use reaches OpenRouter, with the fields of a real call.
      expect(upstreamBodies).toHaveLength(1)
      expect(upstreamBodies[0]).toMatchObject({
        model: claude.slug,
        max_tokens: 1,
        cache_control: { type: "ephemeral" },
        session_id: "claude-side",
        prompt_cache_key: "claude-side",
        reasoning: { effort: "high" },
        messages: [{ role: "user", content: "hi" }],
      })
      expect(upstreamBodies[0]).not.toHaveProperty("max_completion_tokens")
      expect(recorded).toEqual([])
      expect(info.mock.calls.at(-1)?.[1]).toBe(
        JSON.stringify({
          provider: "Private Provider",
          promptTokens: 20_000,
          cacheReadTokens: 19_990,
          cacheWriteTokens: 0,
        }),
      )
    } finally {
      info.mockRestore()
    }
  })

  test("tries a failed Claude ping once more, and answers the same way when both fail", async () => {
    const claude = {
      displayName: "Hidden Model",
      slug: "anthropic/hidden-model",
      canonicalSlug: "anthropic/hidden-model",
      routing: { sort: "throughput" },
    }
    const db = fakeDb({
      assignmentSets: () => [
        { userId: "user-1", scopeID: "turn-1", assignments: [{ assignmentID: "claude-side", model: claude }] },
      ],
    })
    const upstream: (() => Response)[] = [
      () => new Response("overloaded", { status: 529 }),
      () => new Response(`data: ${JSON.stringify({ usage: { prompt_tokens: 10 } })}\n\ndata: [DONE]\n\n`),
      () => {
        throw new TypeError("fetch failed")
      },
      () => {
        throw new TypeError("fetch failed")
      },
    ]
    let sent = 0
    const proxy = openrouter({
      db: async () => db,
      fetch: async () => upstream[sent++]!(),
    })
    const ping = () =>
      proxy(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": "claude-side",
            "X-Arena-Scope-ID": "turn-1",
            "X-Arena-Keep-Alive": "1",
          },
          body: JSON.stringify({ model: "contestant", messages: [{ role: "user", content: "hi" }], stream: true }),
        }),
      )
    const info = spyOn(console, "info").mockImplementation(() => {})
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      const recovered = await ping()
      expect(sent).toBe(2)
      const failed = await ping()
      expect(sent).toBe(4)
      for (const answer of [recovered, failed]) {
        expect(answer.status).toBe(204)
        expect(answer.headers.get("X-Arena-Keep-Alive")).toBe("1")
      }
      expect(warn.mock.calls.map((call) => call[1])).toEqual([
        JSON.stringify({ status: 529 }),
        JSON.stringify({ status: "unsent" }),
        JSON.stringify({ status: "unsent" }),
      ])
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  test("keeps a single-agent chat on one opaque key across its messages", async () => {
    const sessionID = "ses_private-session"
    const scope = (session: string, message: string) =>
      `single-agent|${session.length}:${session}|${message.length}:${message}`
    const sets = [
      { userId: "user-1", scopeID: scope(sessionID, "msg_1"), assignmentID: "first-id", modelSize: "medium" },
      { userId: "user-1", scopeID: scope(sessionID, "msg_2"), assignmentID: "second-id", modelSize: "frontier" },
      { userId: "user-1", scopeID: scope("ses_other", "msg_1"), assignmentID: "other-chat-id", modelSize: "medium" },
      { userId: "user-2", scopeID: scope(sessionID, "msg_3"), assignmentID: "other-user-id", modelSize: "medium" },
      // A battle scope that copies the single-agent shape still keys on its assignment.
      { userId: "user-1", scopeID: scope(sessionID, "msg_4"), assignmentID: "battle-id" },
    ]
    const db = fakeDb({
      assignmentSets: (filter) =>
        sets
          .filter((set) => set.userId === filter.userId && set.scopeID === filter.scopeID)
          .map(({ userId, scopeID, assignmentID, modelSize }) => ({
            userId,
            scopeID,
            assignments: [{ assignmentID, ...(modelSize ? { modelSize } : {}), model: pool[1] }],
          })),
    })
    const upstreamBodies: { session_id?: unknown; prompt_cache_key?: unknown }[] = []
    const keyFor = async ({ userId, scopeID, assignmentID, modelSize }: (typeof sets)[number]) => {
      const response = await openrouter({
        resolveCaller: async () => ({ id: userId }),
        db: async () => db,
        fetch: async (_input, init) => {
          upstreamBodies.push(await new Response(init?.body).json())
          return Response.json({ choices: [] })
        },
      })(
        new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": assignmentID,
            "X-Arena-Scope-ID": scopeID,
          },
          body: JSON.stringify({ model: modelSize === "medium" ? "medium" : "contestant", messages: [] }),
        }),
      )
      expect(response.status).toBe(200)
      const body = upstreamBodies.at(-1)
      expect(body?.session_id).toBe(body?.prompt_cache_key)
      return body?.prompt_cache_key
    }
    const keys: unknown[] = []
    for (const set of sets) keys.push(await keyFor(set))
    const [first, second, otherChat, otherUser, battle] = keys

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(String(first)).not.toContain("private-session")
    expect(otherChat).not.toBe(first)
    expect(otherUser).not.toBe(first)
    expect(battle).toBe("battle-id")
  })

  test("records the metrics a responses stream nests in its event", async () => {
    let recordedMetrics: Record<string, unknown> | undefined
    const db = fakeDb({
      assignmentSets: () => [
        { userId: "user-1", scopeID: "turn-1", assignments: [{ assignmentID: "opaque-id", model: pool[0] }] },
      ],
      recordMetrics: (document) => {
        recordedMetrics = document
      },
    })
    const response = await openrouter({
      db: async () => db,
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "private-id",
              provider: "Private Provider",
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    })(
      new Request("https://control.test/api/openrouter/api/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000003",
        },
        body: JSON.stringify({ model: "contestant", input: [], stream: true }),
      }),
    )

    expect(await response.text()).not.toContain("Private Provider")
    expect(recordedMetrics).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: "completed",
      provider: "Private Provider",
    })
  })

  test("probes every pool profile with the routing fields the proxy adds", async () => {
    const bodies: string[] = []
    const execute = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : ""
      bodies.push(body)
      return body.includes(pool[1]!.slug)
        ? Response.json(
            { error: { message: "No endpoints found that can handle the requested parameters." } },
            { status: 404 },
          )
        : Response.json({ choices: [] })
    }

    const failure = await probeRouting(pool, "key", execute).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure instanceof Error && failure.message).toMatch(/Qwen 3\.8 Max \(404\) .*No endpoints found/)
    expect(bodies).toHaveLength(2)
    const first = JSON.parse(bodies[0]!)
    expect(first).toMatchObject({ model: pool[0]!.slug, provider: pool[0]!.routing, reasoning: { effort: "high" } })
    expect(first.session_id).toEqual(expect.any(String))
    expect(first.prompt_cache_key).toBe(first.session_id)
  })

  // Spends one OpenRouter call per profile, so it runs only when asked:
  // ARENA_PROBE_OPENROUTER_KEY=... bun test src/openrouter.test.ts -t "accepts the routing fields"
  test.skipIf(!process.env.ARENA_PROBE_OPENROUTER_KEY)(
    "the default pool and Medium accept the routing fields on OpenRouter",
    async () => {
      await probeRouting([...defaultPool, mediumModel], process.env.ARENA_PROBE_OPENROUTER_KEY!)
    },
    120_000,
  )

  test("leaves sampling to each provider, because the engine cannot choose it for a hidden model", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const db = fakeDb({
      assignmentSets: () => [
        {
          userId: "user-1",
          scopeID: "turn-1",
          assignments: [
            {
              assignmentID: "opaque-id",
              model: {
                displayName: "Hidden Model",
                slug: "provider/hidden-model",
                canonicalSlug: "provider/hidden-model",
                routing: { require_parameters: true },
              },
            },
          ],
        },
      ],
    })
    const proxy = openrouter({
      db: async () => db,
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
        return Response.json({ choices: [{ message: { content: "A title" } }] })
      },
    })
    const response = await proxy(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
        },
        body: JSON.stringify({
          model: "contestant",
          messages: [],
          stream: false,
          temperature: 0.5,
          top_p: 0.9,
          top_k: 40,
          max_tokens: 32_000,
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody).not.toHaveProperty("temperature")
    expect(upstreamBody).not.toHaveProperty("top_p")
    expect(upstreamBody).not.toHaveProperty("top_k")
    expect(upstreamBody).toMatchObject({ model: "provider/hidden-model", max_tokens: 32_000 })
  })

  test.each([
    { name: "enabled without effort", reasoningEffort: null, expected: { enabled: true } },
    { name: "xhigh effort", reasoningEffort: "xhigh", expected: { effort: "xhigh" } },
  ])("uses the assigned profile's reasoning setting ($name)", async ({ reasoningEffort, expected }) => {
    let upstreamBody: Record<string, unknown> | undefined
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/ui.png" } }] },
    ]
    const tools = [
      { type: "function", function: { name: "inspect_ui", parameters: { type: "object", properties: {} } } },
    ]
    const proxy = openrouter({
      db: async () =>
        fakeDb({
          assignmentSets: () => [
            {
              userId: "user-1",
              scopeID: "turn-1",
              assignments: [{ assignmentID: "opaque-id", model: { ...pool[0], reasoningEffort } }],
            },
          ],
        }),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
        return Response.json({ choices: [] })
      },
    })
    const response = await proxy(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "opaque-id",
          "X-Arena-Scope-ID": "turn-1",
        },
        body: JSON.stringify({ model: "contestant", messages, tools, reasoning: { enabled: false, effort: "low" } }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toEqual(expected)
    expect(upstreamBody).toMatchObject({ messages, tools })
  })

  test("forces xhigh reasoning for a medium assignment", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const proxy = openrouter({
      db: async () =>
        fakeDb({
          assignmentSets: () => [
            {
              userId: "user-1",
              scopeID: "medium-scope",
              assignments: [
                {
                  assignmentID: "medium-id",
                  modelSize: "medium",
                  model: {
                    displayName: "GPT Luna 5.6 Xhigh",
                    slug: "openai/gpt-5.6-luna",
                    canonicalSlug: "openai/gpt-5.6-luna",
                    routing: { sort: "throughput" },
                  },
                },
              ],
            },
          ],
        }),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<string, unknown>
        return Response.json({ choices: [] })
      },
    })
    const response = await proxy(
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "medium-id",
          "X-Arena-Scope-ID": "medium-scope",
        },
        body: JSON.stringify({ model: "medium", messages: [], reasoning: { effort: "low" } }),
      }),
    )
    expect(response.status).toBe(200)
    expect(upstreamBody).toMatchObject({
      model: "openai/gpt-5.6-luna",
      reasoning: { effort: "xhigh" },
    })
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

  test("ends every stream that stops early on an event boundary, so the client can read its error", async () => {
    const assignmentSet = {
      userId: "user-1",
      scopeID: "turn-1",
      assignments: [
        {
          assignmentID: "opaque-id",
          model: { displayName: "Hidden Model", slug: "provider/hidden-model", canonicalSlug: "x", routing: {} },
        },
      ],
    }
    const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    // A slow connection stops wherever the bytes ran out, not on an event boundary.
    for (const [sent, end] of [
      [`${partial}data: {"choi`, "close"],
      [partial.slice(0, -1), "close"],
      [`${partial}data: {"choi`, "error"],
      [partial.slice(0, -1), "error"],
    ] as const) {
      let first = true
      const response = await openrouter({
        db: async () => fakeDb({ assignmentSets: () => [assignmentSet] }),
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (first) {
                  first = false
                  controller.enqueue(new TextEncoder().encode(sent))
                  return
                }
                if (end === "close") controller.close()
                else controller.error(new Error("private transport failure"))
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
      // An SSE client joins the data lines of one event; each event must still be one JSON value.
      const events = body
        .split("\n\n")
        .map((event) =>
          event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n"),
        )
        .filter(Boolean)
        .map((data) => JSON.parse(data) as Record<string, unknown>)
      expect({ sent, end, endsEvent: body.endsWith("\n\n") }).toEqual({ sent, end, endsEvent: true })
      expect(events[0]).toMatchObject({ choices: [{ delta: { content: "partial" } }] })
      // A clean close after a whole line is not an error here: the engine finds no finish and retries.
      if (end === "error" || sent.endsWith('{"choi')) expect(events.at(-1)).toHaveProperty("error")
      else expect(events).toHaveLength(1)
    }
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
