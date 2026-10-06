import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { createArenaService, type ArenaServiceOptions } from "./service"
import { comparisonModel } from "./utility-model"

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
      model: comparisonModel.id,
      messages: [{ role: "user", content: "compare" }],
      temperature: 0,
      reasoning: comparisonModel.reasoning,
      provider: comparisonModel.routing,
    })
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
