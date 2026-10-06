import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { sampleOne, samplePair, validateCatalog, validateOpenRouter, type ModelPool, type ModelProfile } from "./pool"
import { createArenaService } from "./service"

// The control plane's development profiles, so the expectations name real contestants.
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

function catalogModel(profile: ModelProfile) {
  return {
    canonical_slug: profile.canonicalSlug,
    context_length: profile.contextWindow,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["reasoning", "reasoning_effort", "tool_choice", "tools"],
    reasoning: { supported_efforts: ["high"] },
  }
}

function sequence(...values: number[]) {
  return () => values.shift() ?? 0
}

describe("Arena model pool", () => {
  test("retries a failed server-side catalog validation", async () => {
    let calls = 0
    const execute = async (_input: string | URL | Request, init?: RequestInit) => {
      calls++
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret")
      const data = pool.map(catalogModel)
      return Response.json({ data: calls === 1 ? data.slice(0, 2) : data })
    }

    await expect(validateOpenRouter(pool, "server-secret", execute)).rejects.toThrow("Arena contestant is unavailable")
    await expect(validateOpenRouter(pool, "server-secret", execute)).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  test("refuses a contestant that cannot read images", () => {
    const data = pool.map((profile, index) => ({
      ...catalogModel(profile),
      architecture: { input_modalities: index === 0 ? ["text"] : ["text", "image"], output_modalities: ["text"] },
    }))

    expect(() => validateCatalog(pool, { data })).toThrow(`Arena contestant cannot read images: ${pool[0].displayName}`)
  })

  test("the service retries a failed catalog validation and keeps a successful one", async () => {
    let calls = 0
    const existingSet = {
      _id: "set-1",
      userId: "user-1",
      kind: "battle",
      scopeID: "turn-1",
      assignments: [{ assignmentID: "assignment-a" }, { assignmentID: "assignment-b" }],
    }
    const arena = createArenaService({
      resolveCaller: async () => ({ id: "user-1" }),
      db: async () => ({ collection: () => ({ findOne: async () => existingSet }) }) as unknown as ArenaDb,
      pool,
      openRouterApiKey: "server-secret",
      fetch: async (input, init) => {
        calls++
        expect(String(input)).toBe("https://openrouter.ai/api/v1/models/user")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret")
        const data = pool.map(catalogModel)
        return Response.json({ data: calls === 1 ? data.slice(0, 2) : data })
      },
    })
    const create = () =>
      arena.assignments(
        new Request("https://control.test/api/arena/assignments", {
          method: "POST",
          headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", kind: "battle", scopeID: "turn-1" }),
        }),
      )

    const failed = await create()
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual({ error: "Arena contestant is unavailable: Grok 4.6" })
    expect((await create()).status).toBe(200)
    expect((await create()).status).toBe(200)
    expect(calls).toBe(2)
  })

  test("validates only the injected pool against the catalog", () => {
    expect(() => validateCatalog(pool, { data: pool.map(catalogModel) })).not.toThrow()
    expect(() => validateCatalog([pool[0]], { data: [catalogModel(pool[0])] })).not.toThrow()
    expect(() =>
      validateCatalog(pool, {
        data: pool.map((profile) => ({
          ...catalogModel(profile),
          context_length: profile.displayName === "Qwen 3.8 Max" ? 262_144 : profile.contextWindow,
        })),
      }),
    ).toThrow("Arena contestant context window drifted: Qwen 3.8 Max")
  })

  test("samples contestants from the injected pool", () => {
    expect(samplePair(pool, sequence(0, 0.999)).map((profile) => profile.displayName)).toEqual([
      "GLM 5.3 FlashX",
      "Grok 4.6",
    ])
    expect(samplePair(pool, sequence(0.5, 0)).map((profile) => profile.displayName)).toEqual([
      "Qwen 3.8 Max",
      "GLM 5.3 FlashX",
    ])
    expect(sampleOne(pool, () => 0.5).displayName).toBe("Qwen 3.8 Max")
    expect(sampleOne([pool[2]], () => 0.999).displayName).toBe("Grok 4.6")
    expect(() => samplePair(pool, () => 1)).toThrow("Arena assignment randomness must return a finite value in [0, 1)")
  })
})
