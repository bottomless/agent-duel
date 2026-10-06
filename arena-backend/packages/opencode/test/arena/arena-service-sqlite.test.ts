import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { createArenaService, type Fetch, type ModelPool } from "@agent-duel/arena-service"
import { comparisonModel } from "@agent-duel/arena-service/utility-model"
import { connectLocalStore } from "@/arena/local-store"

// Same three profiles as the control plane's development pool, so the
// expectations below name real models.
const pool = [
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
] as const satisfies ModelPool

const [glm, qwen, grok] = pool

type Upstream = {
  readonly url: string
  readonly authorization: string | null
  readonly body: Record<string, unknown>
}

function upstreamBody(body: RequestInit["body"]) {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer)
  return JSON.parse(text) as Record<string, unknown>
}

/** A service over a fresh SQLite local store, with every source of randomness fixed. */
async function localService(input: { readonly ids: string[]; readonly random: number[] }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-service-sqlite-"))
  const store = await connectLocalStore({ directory })
  const upstream: Upstream[] = []
  const validatedKeys: string[] = []
  const fetch: Fetch = async (url, init) => {
    const body = upstreamBody(init?.body)
    upstream.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), body })
    return Response.json({
      id: "provider-generation",
      model: body.model,
      provider: "hidden-provider",
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.123 },
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    })
  }
  const service = createArenaService({
    resolveCaller: async () => ({ id: "local" }),
    db: async () => store.db,
    pool,
    openRouterApiKey: "user-key",
    validateModels: async (apiKey) => {
      validatedKeys.push(apiKey)
    },
    fetch,
    uuid: () => input.ids.shift() ?? crypto.randomUUID(),
    random: () => input.random.shift() ?? 0,
    now: () => new Date("2000-01-01T00:00:00.000Z"),
  })
  async function send(request: Request) {
    const response = await service.route(request)
    if (!response) throw new Error(`No Arena route answered ${request.url}`)
    return response
  }
  return {
    upstream,
    validatedKeys,
    assignments: (body: unknown) =>
      send(
        new Request("http://arena.local/api/arena/assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    contestant: (scopeID: string, assignmentID: string, generationID?: string) =>
      send(
        new Request("http://arena.local/api/openrouter/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Arena-Assignment-ID": assignmentID,
            "X-Arena-Scope-ID": scopeID,
            ...(generationID ? { "X-Arena-Generation-ID": generationID } : {}),
          },
          body: JSON.stringify({ model: "contestant", messages: [{ role: "user", content: "fix it" }], stream: false }),
        }),
      ),
    comparison: (scopeID: string) =>
      send(
        new Request("http://arena.local/api/arena/comparison", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID, messages: [{ role: "user", content: "compare" }], temperature: 0 }),
        }),
      ),
    async [Symbol.asyncDispose]() {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const generationA = `gen_${"a".repeat(32)}`
const generationB = `gen_${"b".repeat(32)}`

describe("Arena service on the desktop SQLite local store", () => {
  // Sets used to be looked up by the dotted path "assignments.assignmentID",
  // which matches 0 rows here because the query emulation cannot reach into an
  // array, so every contestant call answered 403.
  test("routes contestant calls for both battle sides (a dotted-path assignment lookup matches 0 rows on SQLite)", async () => {
    await using arena = await localService({ ids: ["assignment-a", "assignment-b"], random: [0, 0.999] })

    const created = await arena.assignments({ action: "create", kind: "battle", scopeID: "turn-1" })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      assignments: [{ assignmentID: "assignment-a" }, { assignmentID: "assignment-b" }],
    })
    expect(arena.validatedKeys).toEqual(["user-key"])

    const sideA = await arena.contestant("turn-1", "assignment-a", generationA)
    expect(sideA.status).toBe(200)
    const sideAText = await sideA.text()
    expect(sideAText).not.toContain(glm.slug)
    expect(sideAText).not.toContain("hidden-provider")

    const sideB = await arena.contestant("turn-1", "assignment-b", generationB)
    expect(sideB.status).toBe(200)
    expect(await sideB.text()).not.toContain(grok.slug)

    expect(arena.upstream).toHaveLength(2)
    expect(arena.upstream[0]).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      authorization: "Bearer user-key",
      body: {
        model: glm.slug,
        messages: [{ role: "user", content: "fix it" }],
        stream: false,
        reasoning: { effort: "high" },
        provider: glm.routing,
        stream_options: { include_usage: true },
      },
    })
    expect(arena.upstream[1]?.body).toMatchObject({ model: grok.slug, provider: grok.routing })

    const unknown = await arena.contestant("turn-1", "assignment-unknown")
    expect(unknown.status).toBe(403)
    expect(arena.upstream).toHaveLength(2)

    const comparison = await arena.comparison("turn-1")
    expect(comparison.status).toBe(200)
    expect(arena.upstream).toHaveLength(3)
    expect(arena.upstream[2]?.body).toMatchObject({ model: comparisonModel.id, provider: comparisonModel.routing })

    const resolved = await arena.assignments({
      action: "resolve",
      kind: "battle",
      scopeID: "turn-1",
      decision: "select:b",
    })
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toMatchObject({
      decision: "select:b",
      assignments: [
        {
          assignmentID: "assignment-a",
          model: glm.displayName,
          metrics: [
            { generationID: generationA, usage: { promptTokens: 10, completionTokens: 5 }, finishReason: "stop" },
          ],
        },
        {
          assignmentID: "assignment-b",
          model: grok.displayName,
          metrics: [
            { generationID: generationB, usage: { promptTokens: 10, completionTokens: 5 }, finishReason: "stop" },
          ],
        },
      ],
    })

    const afterVote = await arena.contestant("turn-1", "assignment-a")
    expect(afterVote.status).toBe(403)
    expect(await afterVote.json()).toEqual({ error: { message: "Arena assignment is invalid" } })
    expect((await arena.comparison("turn-1")).status).toBe(403)
    expect(arena.upstream).toHaveLength(3)
  })

  test("routes a single-contestant call (a dotted-path assignment lookup matches 0 rows on SQLite)", async () => {
    await using arena = await localService({ ids: ["assignment-single"], random: [0.5] })

    const created = await arena.assignments({ action: "create", kind: "single", scopeID: "turn-single" })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ assignments: [{ assignmentID: "assignment-single" }] })

    const routed = await arena.contestant("turn-single", "assignment-single")
    expect(routed.status).toBe(200)
    expect(await routed.text()).not.toContain(qwen.slug)
    expect(arena.upstream).toHaveLength(1)
    expect(arena.upstream[0]?.body).toMatchObject({ model: qwen.slug, provider: qwen.routing })

    expect((await arena.contestant("turn-other", "assignment-single")).status).toBe(403)
    expect(arena.upstream).toHaveLength(1)
  })
})
