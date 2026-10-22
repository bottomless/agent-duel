import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { createArenaService, type ArenaServiceOptions } from "./service"
import { utilityModels } from "./utility-model"

function request(body: unknown) {
  return new Request("https://control.test/api/arena/comparison", {
    method: "POST",
    headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function dbWithSet(set: { _id: string } | null) {
  return { collection: () => ({ findOne: async () => set }) } as unknown as ArenaDb
}

function service(options: Partial<ArenaServiceOptions>) {
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => dbWithSet({ _id: "set-1" }),
    // The comparison route never samples a contestant.
    pool: [],
    openRouterApiKey: "server-secret",
    ...options,
  })
}

describe("Arena comparison control plane", () => {
  test("routes the fixed utility model for an active battle scope", async () => {
    let upstreamBody: unknown
    const response = await service({
      db: async () => dbWithSet({ _id: "set-1" }),
      fetch: async (_url, init) => {
        upstreamBody = JSON.parse(String(init?.body))
        return Response.json({ choices: [{ message: { content: "A" } }] })
      },
    }).comparison(request({ scopeID: "turn-1", messages: [{ role: "user", content: "compare" }], temperature: 0 }))

    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: "compare" }],
      temperature: 0,
      reasoning: { effort: "low" },
      provider: { order: ["cerebras"], allow_fallbacks: false, require_parameters: true },
    })
  })

  test("falls back to DeepSeek on Baseten with reasoning off when Qwen on Cerebras fails", async () => {
    const upstream: Record<string, unknown>[] = []
    const response = await service({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        upstream.push(body)
        if (body.model === utilityModels[0].id) return Response.json({ error: "rate limited" }, { status: 429 })
        return Response.json({ choices: [{ message: { content: "B" } }] })
      },
    }).comparison(request({ scopeID: "turn-1", messages: [{ role: "user", content: "compare" }], temperature: 0 }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ choices: [{ message: { content: "B" } }] })
    expect(upstream.map((body) => body.model)).toEqual(["qwen/qwen3.8-27b", "deepseek/deepseek-v4.1-flash-1017"])
    expect(upstream[1]).toEqual({
      model: "deepseek/deepseek-v4.1-flash-1017",
      messages: [{ role: "user", content: "compare" }],
      temperature: 0,
      reasoning: { enabled: false },
      provider: { order: ["baseten"], allow_fallbacks: false, require_parameters: true },
    })
  })

  test("falls back when the first model cannot be reached and passes the last failure through", async () => {
    const models: unknown[] = []
    const response = await service({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        models.push(body.model)
        if (body.model === utilityModels[0].id) throw new TypeError("fetch failed")
        return Response.json({ error: "overloaded" }, { status: 503, headers: { "Retry-After": "2" } })
      },
    }).comparison(request({ scopeID: "turn-1", messages: [{ role: "user", content: "compare" }], temperature: 0 }))

    expect(models).toEqual(["qwen/qwen3.8-27b", "deepseek/deepseek-v4.1-flash-1017"])
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("2")
  })

  test("rejects invalid scopes before contacting OpenRouter", async () => {
    let contacted = false
    const response = await service({
      db: async () => dbWithSet(null),
      fetch: async () => {
        contacted = true
        return Response.json({})
      },
    }).comparison(request({ scopeID: "turn-1", messages: [{ role: "user", content: "compare" }], temperature: 0 }))

    expect(response.status).toBe(403)
    expect(contacted).toBe(false)
  })

  test("answers 503 without contacting OpenRouter when the Arena database is unavailable", async () => {
    let contacted = false
    const response = await service({
      db: async () => {
        throw new Error("connection refused")
      },
      fetch: async () => {
        contacted = true
        return Response.json({})
      },
    }).comparison(request({ scopeID: "turn-1", messages: [{ role: "user", content: "compare" }], temperature: 0 }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "Arena comparison is unavailable" })
    expect(contacted).toBe(false)
  })

  test("does not limit comparison calls, scope length, or message size", async () => {
    let contacted = 0
    const body = {
      scopeID: `turn-${"s".repeat(4_096)}`,
      messages: [{ role: "user", content: "x".repeat(1_000_001) }],
      temperature: 0,
    }
    const arena = service({
      db: async () => dbWithSet({ _id: "set-1" }),
      fetch: async () => {
        contacted += 1
        return Response.json({ choices: [{ message: { content: "A" } }] })
      },
    })

    for (let requestIndex = 0; requestIndex < 9; requestIndex += 1) {
      expect(await arena.comparison(request(body))).toHaveProperty("status", 200)
    }
    expect(contacted).toBe(9)
  })

  test("rejects caller-controlled model and routing fields", async () => {
    let contacted = false
    const response = await service({
      // Validation answers before the database is opened.
      db: async () => {
        throw new Error("the Arena database must not be opened")
      },
      fetch: async () => {
        contacted = true
        return Response.json({})
      },
    }).comparison(
      request({
        scopeID: "turn-1",
        messages: [{ role: "user", content: "compare" }],
        temperature: 0,
        model: "openai/gpt-4.1-nano",
      }),
    )

    expect(response.status).toBe(400)
    expect(contacted).toBe(false)
  })
})
