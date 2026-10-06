import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { recordAssignmentGenerationMetrics, reserveRoutingAssignment } from "./assignments"
import { connectMongoDb } from "./mongo"
import type { ModelPool } from "./pool"
import { createArenaService } from "./service"

const uri = process.env.OPENCODE_ARENA_MONGODB_URI
const database = `agent_duel_assignments_test_${crypto.randomUUID().replaceAll("-", "")}`
let mongo: Awaited<ReturnType<typeof connectMongoDb>>

// The control plane's development profiles, so the expected model names stay meaningful.
const pool: ModelPool = [
  {
    displayName: "GLM 5.3 FlashX",
    slug: "z-ai/glm-5.3-flashx",
    canonicalSlug: "z-ai/glm-5.3-flashx-20260918",
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

beforeAll(async () => {
  if (!uri) throw new Error("OPENCODE_ARENA_MONGODB_URI must be set to run the assignment tests")
  mongo = await connectMongoDb({ uri, database })
})

beforeEach(async () => {
  await mongo.db.collection("arenaAssignmentSets").deleteMany({})
  await mongo.db.collection("arenaAssignmentGenerationMetrics").deleteMany({})
})

afterAll(async () => {
  if (!uri) return
  await mongo.client.db(database).dropDatabase()
  await mongo.client.close()
})

function request(body: unknown) {
  return new Request("https://control.test/api/arena/assignments", {
    method: "POST",
    headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function service(
  options: { readonly userId?: string; readonly ids?: readonly string[]; readonly random?: readonly number[] } = {},
) {
  const ids = [...(options.ids ?? ["assignment-a", "assignment-b"])]
  const random = [...(options.random ?? [0, 0.999])]
  return createArenaService({
    resolveCaller: async () => ({ id: options.userId ?? "user-1" }),
    db: async () => mongo.db,
    pool,
    openRouterApiKey: "server-secret",
    uuid: () => ids.shift() ?? crypto.randomUUID(),
    random: () => random.shift() ?? 0,
    now: () => new Date("2000-01-01T00:00:00.000Z"),
    validateModels: async () => undefined,
  })
}

describe("Arena assignment control plane", () => {
  test("keeps the model mapping private until an immutable decision is committed", async () => {
    const create = await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-1" }))
    const publicPayload = (await create.json()) as Record<string, unknown>
    expect(publicPayload).toEqual({
      assignments: [{ assignmentID: "assignment-a" }, { assignmentID: "assignment-b" }],
    })
    expect(JSON.stringify(publicPayload)).not.toContain("routingToken")
    expect(JSON.stringify(publicPayload)).not.toContain("GLM")
    expect(JSON.stringify(publicPayload)).not.toContain("Grok")

    const stored = await mongo.db
      .collection<{
        _id: string
        assignments: readonly { assignmentID: string; model: { displayName: string } }[]
        expiresAt?: Date
      }>("arenaAssignmentSets")
      .findOne({ scopeID: "turn-1" })
    expect(stored?.assignments.map((value: { model: { displayName: string } }) => value.model.displayName)).toEqual([
      "GLM 5.3 FlashX",
      "Grok 4.6",
    ])
    expect(stored?.assignments.every((value) => !("routingToken" in value))).toBe(true)
    expect(stored?.expiresAt).toBeUndefined()
    const listed = (await mongo.db.command({ listIndexes: "arenaAssignmentSets" })) as {
      cursor?: { firstBatch?: Array<{ key: Record<string, number>; expireAfterSeconds?: number }> }
    }
    const indexes = listed.cursor?.firstBatch ?? []
    expect(indexes.some((index) => index.key.expiresAt === 1 || index.expireAfterSeconds !== undefined)).toBe(false)

    const retry = await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-1" }))
    expect(await retry.json()).toEqual(publicPayload)

    const resolved = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-1", decision: "select:a" }),
    )
    expect(await resolved.json()).toEqual({
      decision: "select:a",
      assignments: [
        { assignmentID: "assignment-a", model: "GLM 5.3 FlashX" },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })
  })

  test("rejects invalid decisions without revealing or resolving the assignment", async () => {
    await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-invalid" }))

    for (const decision of ["anything", "rate:up", "select:c", ""]) {
      const response = await service().assignments(
        request({ action: "resolve", kind: "battle", scopeID: "turn-invalid", decision }),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Arena assignment decision is invalid" })
    }

    const stored = await mongo.db
      .collection<{ _id: string; decision?: string }>("arenaAssignmentSets")
      .findOne({ scopeID: "turn-invalid" })
    expect(stored?.decision).toBeUndefined()
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-invalid", "assignment-a")).toBeDefined()
  })

  test("returns server-held generation metrics only with the committed resolution", async () => {
    await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-metrics" }))
    await recordAssignmentGenerationMetrics(mongo.db, {
      userId: "user-1",
      scopeID: "turn-metrics",
      assignmentID: "assignment-a",
      metrics: {
        generationID: "gen_00000000000000000000000000000001",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          reasoningTokens: 2,
          totalTokens: 15,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          cost: 0.123,
          attempts: 1,
          latencyMs: 250,
        },
        finishReason: "tool_calls",
      },
    })

    const retry = await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-metrics" }))
    expect(JSON.stringify(await retry.json())).not.toContain("promptTokens")

    const resolved = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-metrics", decision: "select:a" }),
    )
    expect(await resolved.json()).toMatchObject({
      decision: "select:a",
      assignments: [
        {
          assignmentID: "assignment-a",
          model: "GLM 5.3 FlashX",
          metrics: [
            {
              generationID: "gen_00000000000000000000000000000001",
              usage: { promptTokens: 10, completionTokens: 5, cost: 0.123 },
              finishReason: "tool_calls",
            },
          ],
        },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })
  })

  test("rejects the removed reveal action", async () => {
    const response = await service().assignments(
      request({ action: "reveal", kind: "battle", scopeID: "turn-removed", decision: "select:a" }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Arena assignment action is invalid" })
  })

  test("returns the first committed decision when resolution is retried", async () => {
    await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-resolve" }))

    const first = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-resolve", decision: "select:a" }),
    )
    expect(await first.json()).toEqual({
      decision: "select:a",
      assignments: [
        { assignmentID: "assignment-a", model: "GLM 5.3 FlashX" },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })

    const retry = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-resolve", decision: "select:b" }),
    )
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({
      decision: "select:a",
      assignments: [
        { assignmentID: "assignment-a", model: "GLM 5.3 FlashX" },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })
  })

  test("validates single-agent decisions separately", async () => {
    await service().assignments(request({ action: "create", kind: "single", scopeID: "rating-1" }))

    const invalid = await service().assignments(
      request({ action: "resolve", kind: "single", scopeID: "rating-1", decision: "select:a" }),
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: "Arena assignment decision is invalid" })

    const resolved = await service().assignments(
      request({ action: "resolve", kind: "single", scopeID: "rating-1", decision: "rate:down" }),
    )
    expect(await resolved.json()).toMatchObject({ decision: "rate:down" })
  })

  test("rejects client-directed assignment exclusions", async () => {
    const response = await service().assignments(
      request({
        action: "create",
        kind: "single",
        scopeID: "rating-exclusion-oracle",
        excludeAssignmentID: "assignment-a",
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Arena assignment request contains an unsupported field" })
    expect(await mongo.db.collection("arenaAssignmentSets").findOne({ scopeID: "rating-exclusion-oracle" })).toBeNull()
  })

  test("retains assignments and scopes routing to the signed-in account and battle", async () => {
    await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-2" }))

    expect((await reserveRoutingAssignment(mongo.db, "user-1", "turn-2", "assignment-a"))?.model.displayName).toBe(
      "GLM 5.3 FlashX",
    )
    expect(await reserveRoutingAssignment(mongo.db, "user-2", "turn-2", "assignment-a")).toBeUndefined()
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-other", "assignment-a")).toBeUndefined()

    const resolved = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-2", decision: "select:a" }),
    )
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toEqual({
      decision: "select:a",
      assignments: [
        { assignmentID: "assignment-a", model: "GLM 5.3 FlashX" },
        { assignmentID: "assignment-b", model: "Grok 4.6" },
      ],
    })
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-2", "assignment-a")).toBeUndefined()
  })

  test("finds single and battle assignments by assignment id until their set is resolved", async () => {
    const battle = await service({ ids: ["battle-a", "battle-b"] }).assignments(
      request({ action: "create", kind: "battle", scopeID: "turn-kinds" }),
    )
    expect(battle.status).toBe(200)
    const single = await service({ ids: ["single-a"], random: [0.5] }).assignments(
      request({ action: "create", kind: "single", scopeID: "turn-kinds" }),
    )
    expect(single.status).toBe(200)

    expect((await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "battle-a"))?.model.displayName).toBe(
      "GLM 5.3 FlashX",
    )
    expect((await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "battle-b"))?.model.displayName).toBe(
      "Grok 4.6",
    )
    expect((await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "single-a"))?.model.displayName).toBe(
      "Qwen 3.8 Max",
    )
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "missing")).toBeUndefined()

    const resolvedSingle = await service().assignments(
      request({ action: "resolve", kind: "single", scopeID: "turn-kinds", decision: "rate:up" }),
    )
    expect(resolvedSingle.status).toBe(200)
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "single-a")).toBeUndefined()
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "battle-a")).toBeDefined()

    const resolvedBattle = await service().assignments(
      request({ action: "resolve", kind: "battle", scopeID: "turn-kinds", decision: "select:b" }),
    )
    expect(resolvedBattle.status).toBe(200)
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "battle-a")).toBeUndefined()
    expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-kinds", "battle-b")).toBeUndefined()
  })

  test("does not limit inference calls while an assignment remains unresolved", async () => {
    await service().assignments(request({ action: "create", kind: "battle", scopeID: "turn-unlimited" }))

    for (let requestIndex = 0; requestIndex < 513; requestIndex += 1) {
      expect(await reserveRoutingAssignment(mongo.db, "user-1", "turn-unlimited", "assignment-a")).toBeDefined()
    }
    const stored = await mongo.db
      .collection<{ _id: string; assignments: readonly Record<string, unknown>[] }>("arenaAssignmentSets")
      .findOne({ scopeID: "turn-unlimited" })
    expect(stored?.assignments.every((value) => !("requestCount" in value))).toBe(true)
    expect(await mongo.db.collection("arenaInferenceBudgets").find({}).toArray()).toHaveLength(0)
  })

  test("does not limit assignment scope length", async () => {
    const scopeID = `turn-${"x".repeat(4_096)}`
    const response = await service().assignments(request({ action: "create", kind: "battle", scopeID }))

    expect(response.status).toBe(200)
    expect(await mongo.db.collection("arenaAssignmentSets").findOne({ scopeID })).toBeDefined()
  })
})
