import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { MongoClient } from "mongodb"
import type { Caller } from "./context"
import { connectMongoDb, type MongoDb } from "./mongo"
import type { ModelPool } from "./pool"
import { createArenaService, type ArenaService, type ArenaServiceOptions } from "./service"
import { comparisonModel } from "./utility-model"

const uri = process.env.OPENCODE_ARENA_MONGODB_URI
const database = `agent_duel_service_test_${crypto.randomUUID().replaceAll("-", "")}`
let client: MongoClient
let db: MongoDb

const testPool = [
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
] as const satisfies ModelPool

const fixedNow = new Date("2000-01-01T00:00:00.000Z")
const generationID = "gen_00000000000000000000000000000001"

beforeAll(async () => {
  if (!uri) throw new Error("OPENCODE_ARENA_MONGODB_URI must be set to run the Arena service tests")
  ;({ client, db } = await connectMongoDb({ uri, database }))
})

beforeEach(async () => {
  await db.collection("arenaAssignmentSets").deleteMany({})
  await db.collection("arenaAssignmentGenerationMetrics").deleteMany({})
})

afterAll(async () => {
  if (!uri) return
  await client.db(database).dropDatabase()
  await client.close()
})

type UpstreamCall = {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** Callers authenticate as `Bearer <user id>`; no Authorization header means no caller. */
async function callerFromHeader(request: Request): Promise<Caller | undefined> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
  return token ? { id: token } : undefined
}

function createService(overrides: Partial<ArenaServiceOptions> = {}) {
  const ids = ["assignment-a", "assignment-b"]
  const random = [0, 0.999]
  const upstream: UpstreamCall[] = []
  const validated: string[] = []
  const service = createArenaService({
    resolveCaller: callerFromHeader,
    db: async () => db,
    pool: testPool,
    openRouterApiKey: "server-secret",
    uuid: () => ids.shift() ?? crypto.randomUUID(),
    random: () => random.shift() ?? 0,
    now: () => fixedNow,
    validateModels: async (apiKey) => {
      validated.push(apiKey)
    },
    fetch: async (input, init) => {
      const raw = init?.body
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)
      const body = JSON.parse(text) as Record<string, unknown>
      upstream.push({ url: String(input), headers: new Headers(init?.headers), body })
      if (body.model === comparisonModel.id) return Response.json({ choices: [{ message: { content: "A" } }] })
      return Response.json(
        {
          id: "provider-generation",
          model: body.model,
          provider: "hidden-provider",
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.123 },
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        },
        { headers: { "x-openrouter-provider": "hidden-provider" } },
      )
    },
    ...overrides,
  })
  return { service, upstream, validated }
}

async function send(service: ArenaService, request: Request) {
  const response = await service.route(request)
  if (!response) throw new Error(`Arena service did not route ${new URL(request.url).pathname}`)
  return response
}

function assignmentsRequest(body: unknown, userId: string | undefined = "user-1") {
  return new Request("https://control.test/api/arena/assignments", {
    method: "POST",
    headers: { ...(userId ? { Authorization: `Bearer ${userId}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function comparisonRequest(scopeID: string, userId: string | undefined = "user-1") {
  return new Request("https://control.test/api/arena/comparison", {
    method: "POST",
    headers: { ...(userId ? { Authorization: `Bearer ${userId}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ scopeID, messages: [{ role: "user", content: "compare" }], temperature: 0 }),
  })
}

function contestantRequest(
  input: { readonly assignmentID: string; readonly scopeID: string },
  userId: string | undefined = "user-1",
) {
  return new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
    method: "POST",
    headers: {
      ...(userId ? { Authorization: `Bearer ${userId}` } : {}),
      "Content-Type": "application/json",
      "X-Arena-Assignment-ID": input.assignmentID,
      "X-Arena-Scope-ID": input.scopeID,
      "X-Arena-Generation-ID": generationID,
    },
    body: JSON.stringify({
      model: "contestant",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  })
}

describe("Arena service", () => {
  test("routes only its three paths", async () => {
    let resolved = 0
    const { service } = createService({
      resolveCaller: async (request) => {
        resolved += 1
        return callerFromHeader(request)
      },
    })

    for (const path of [
      "/api/unknown",
      "/api/arena/assignments/extra",
      "/api/arena",
      "/api/openrouter",
      "/openrouter/api/v1/chat/completions",
    ]) {
      expect(
        await service.route(new Request(`https://control.test${path}`, { method: "POST", body: "{}" })),
      ).toBeUndefined()
    }
    expect(resolved).toBe(0)

    const assignments = await send(service, assignmentsRequest({ action: "unknown" }))
    expect(assignments.status).toBe(400)
    expect(await assignments.json()).toEqual({ error: "Arena assignment action is invalid" })

    const comparison = await send(
      service,
      new Request("https://control.test/api/arena/comparison", {
        method: "POST",
        headers: { Authorization: "Bearer user-1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(comparison.status).toBe(400)
    expect(await comparison.json()).toEqual({ error: "Arena comparison request is invalid" })

    const openrouter = await send(
      service,
      new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer user-1", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant", messages: [] }),
      }),
    )
    expect(openrouter.status).toBe(400)
    expect(await openrouter.json()).toEqual({ error: { message: "Arena assignment scope is invalid" } })
    expect(resolved).toBe(3)
  })

  test("runs a battle from assignment to resolution for one caller", async () => {
    const { service, upstream, validated } = createService()

    const created = await send(service, assignmentsRequest({ action: "create", kind: "battle", scopeID: "turn-1" }))
    expect(created.status).toBe(200)
    const publicPayload = await created.json()
    expect(publicPayload).toEqual({
      assignments: [{ assignmentID: "assignment-a" }, { assignmentID: "assignment-b" }],
    })
    for (const profile of testPool) {
      expect(JSON.stringify(publicPayload)).not.toContain(profile.displayName)
      expect(JSON.stringify(publicPayload)).not.toContain(profile.slug)
    }
    expect(validated).toEqual(["server-secret"])

    const routed = await send(service, contestantRequest({ assignmentID: "assignment-a", scopeID: "turn-1" }))
    expect(routed.status).toBe(200)
    expect(upstream).toHaveLength(1)
    const contestantCall = upstream[0]!
    expect(contestantCall.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(contestantCall.headers.get("authorization")).toBe("Bearer server-secret")
    expect(contestantCall.body).toEqual({
      model: "z-ai/glm-5.2-20260616",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      reasoning: { effort: "high" },
      provider: {
        sort: "throughput",
        require_parameters: true,
        max_price: { prompt: 2.1, completion: 6.6 },
      },
      stream_options: { include_usage: true },
    })
    expect(routed.headers.get("x-openrouter-provider")).toBeNull()
    const routedPayload = (await routed.json()) as Record<string, unknown>
    expect(routedPayload).toEqual({
      id: generationID,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    })
    expect(JSON.stringify(routedPayload)).not.toContain("z-ai/glm")
    expect(JSON.stringify(routedPayload)).not.toContain("hidden-provider")
    expect(JSON.stringify(routedPayload)).not.toContain("0.123")

    const compared = await send(service, comparisonRequest("turn-1"))
    expect(compared.status).toBe(200)
    expect(await compared.json()).toEqual({ choices: [{ message: { content: "A" } }] })
    expect(upstream).toHaveLength(2)
    expect(upstream[1]!.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(upstream[1]!.body).toEqual({
      model: comparisonModel.id,
      messages: [{ role: "user", content: "compare" }],
      temperature: 0,
      reasoning: comparisonModel.reasoning,
      provider: comparisonModel.routing,
    })

    const resolved = await send(
      service,
      assignmentsRequest({ action: "resolve", kind: "battle", scopeID: "turn-1", decision: "select:a" }),
    )
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toEqual({
      decision: "select:a",
      assignments: [
        {
          assignmentID: "assignment-a",
          model: "GLM 5.2",
          metrics: [
            {
              generationID,
              usage: {
                promptTokens: 10,
                completionTokens: 5,
                reasoningTokens: 0,
                totalTokens: 15,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                cost: 0.123,
                attempts: 1,
                latencyMs: expect.any(Number),
              },
              finishReason: "stop",
            },
          ],
        },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })
    const stored = await db
      .collection<{ _id: string; createdAt: Date; decision?: string; revealedAt?: Date }>("arenaAssignmentSets")
      .findOne({ scopeID: "turn-1" })
    expect(stored).toMatchObject({ createdAt: fixedNow, decision: "select:a", revealedAt: fixedNow })

    const afterResolution = await send(service, contestantRequest({ assignmentID: "assignment-a", scopeID: "turn-1" }))
    expect(afterResolution.status).toBe(403)
    expect(await afterResolution.json()).toEqual({ error: { message: "Arena assignment is invalid" } })
    const comparedAfterResolution = await send(service, comparisonRequest("turn-1"))
    expect(comparedAfterResolution.status).toBe(403)
    expect(await comparedAfterResolution.json()).toEqual({ error: "Arena comparison scope is invalid" })
    expect(upstream).toHaveLength(2)
  })

  test("does not let another caller use an assignment", async () => {
    const { service, upstream } = createService()
    const created = await send(service, assignmentsRequest({ action: "create", kind: "battle", scopeID: "turn-1" }))
    expect(created.status).toBe(200)

    const stolen = await send(service, contestantRequest({ assignmentID: "assignment-a", scopeID: "turn-1" }, "user-2"))
    expect(stolen.status).toBe(403)
    expect(await stolen.json()).toEqual({ error: { message: "Arena assignment is invalid" } })
    const compared = await send(service, comparisonRequest("turn-1", "user-2"))
    expect(compared.status).toBe(403)
    expect(upstream).toHaveLength(0)

    const owned = await send(service, contestantRequest({ assignmentID: "assignment-a", scopeID: "turn-1" }))
    expect(owned.status).toBe(200)
    expect(upstream).toHaveLength(1)
  })

  describe("caller resolution", () => {
    const routes = [
      {
        name: "assignments",
        request: () => assignmentsRequest({ action: "create", kind: "battle", scopeID: "turn-1" }, undefined),
        error: (message: string) => ({ error: message }),
      },
      {
        name: "comparison",
        request: () => comparisonRequest("turn-1", undefined),
        error: (message: string) => ({ error: message }),
      },
      {
        name: "openrouter",
        request: () => contestantRequest({ assignmentID: "assignment-a", scopeID: "turn-1" }, undefined),
        error: (message: string) => ({ error: { message } }),
      },
    ] as const

    function isolatedService(resolveCaller: ArenaServiceOptions["resolveCaller"]) {
      let dbCalls = 0
      const created = createService({
        resolveCaller,
        db: async () => {
          dbCalls += 1
          return db
        },
      })
      return { ...created, dbCalls: () => dbCalls }
    }

    for (const route of routes) {
      test(`${route.name} answers 401 when there is no caller`, async () => {
        const { service, upstream, validated, dbCalls } = isolatedService(async () => undefined)
        const response = await send(service, route.request())
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual(route.error("Unauthorized"))
        expect(dbCalls()).toBe(0)
        expect(validated).toEqual([])
        expect(upstream).toHaveLength(0)
      })

      test(`${route.name} answers with a Response the deployment throws`, async () => {
        const { service, upstream, validated, dbCalls } = isolatedService(async () => {
          throw Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": "60" } })
        })
        const response = await send(service, route.request())
        expect(response.status).toBe(429)
        expect(response.headers.get("retry-after")).toBe("60")
        expect(await response.json()).toEqual({ error: "Too many requests" })
        expect(dbCalls()).toBe(0)
        expect(validated).toEqual([])
        expect(upstream).toHaveLength(0)
      })

      test(`${route.name} answers 503 when caller resolution fails`, async () => {
        const { service, upstream, validated, dbCalls } = isolatedService(async () => {
          throw new Error("accounts database is down")
        })
        const response = await send(service, route.request())
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual(route.error("Arena accounts are unavailable"))
        expect(dbCalls()).toBe(0)
        expect(validated).toEqual([])
        expect(upstream).toHaveLength(0)
      })
    }
  })
})
