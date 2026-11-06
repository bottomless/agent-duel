import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { createArenaService, type ArenaServiceOptions } from "./service"
import { webSearchResults } from "./websearch"

function request(body: unknown, method = "POST") {
  return new Request("https://control.test/api/arena/websearch", {
    method,
    headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  })
}

/** An in-memory `arenaWebSearchLimits` collection. */
function limitDb() {
  const documents = new Map<string, { _id: string; window: number; count: number }>()
  return {
    collection: () => ({
      findOneAndUpdate: async (filter: { _id: string; window: number }) => {
        const document = documents.get(filter._id)
        if (!document || document.window !== filter.window) return null
        document.count++
        return document
      },
      replaceOne: async (_filter: unknown, document: { _id: string; window: number; count: number }) => {
        documents.set(document._id, { ...document })
      },
    }),
  } as unknown as ArenaDb
}

const citations = {
  choices: [
    {
      message: {
        content: "ok",
        annotations: [
          {
            type: "url_citation",
            url_citation: { url: "https://docs.expo.dev/versions/latest/", title: " Expo SDK ", content: "SDK 58" },
          },
          { type: "url_citation", url_citation: { url: "https://docs.expo.dev/versions/latest/", title: "again" } },
          { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "not a page" } },
          { type: "file", file: {} },
          { type: "url_citation", url_citation: { url: "https://npmjs.com/package/expo" } },
        ],
      },
    },
  ],
}

function service(options: Partial<ArenaServiceOptions>) {
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => limitDb(),
    pool: [],
    openRouterApiKey: "server-secret",
    ...options,
  })
}

describe("Arena web search", () => {
  test("searches through OpenRouter's web plugin on the utility model and returns the citations", async () => {
    let upstreamURL: unknown
    let upstreamBody: unknown
    const response = await service({
      fetch: async (url, init) => {
        upstreamURL = url
        upstreamBody = JSON.parse(String(init?.body))
        return Response.json(citations)
      },
    }).route(request({ query: "  latest expo sdk  " }))

    expect(response?.status).toBe(200)
    expect(upstreamURL).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(upstreamBody).toEqual({
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: "latest expo sdk" }],
      plugins: [{ id: "web", max_results: 8 }],
      max_tokens: 16,
      reasoning: { effort: "low" },
      provider: { order: ["cerebras"], allow_fallbacks: false, require_parameters: true },
    })
    expect(await response?.json()).toEqual({
      results: [
        { url: "https://docs.expo.dev/versions/latest/", title: "Expo SDK", content: "SDK 58" },
        { url: "https://npmjs.com/package/expo" },
      ],
    })
  })

  test("refuses a bad request before any upstream call", async () => {
    let calls = 0
    const routes = service({
      fetch: async () => {
        calls++
        return Response.json(citations)
      },
    })
    expect((await routes.websearch(request({}, "GET"))).status).toBe(405)
    for (const body of [{}, { query: "" }, { query: 1 }, { query: "x".repeat(401) }, { query: "x", model: "y" }])
      expect((await routes.websearch(request(body))).status).toBe(400)
    expect((await service({ resolveCaller: async () => undefined }).websearch(request({ query: "x" }))).status).toBe(
      401,
    )
    expect((await service({ openRouterApiKey: undefined }).websearch(request({ query: "x" }))).status).toBe(503)
    expect(calls).toBe(0)
  })

  test("limits each account per window, and a BYOK service has no limit", async () => {
    const db = limitDb()
    const fetch = async () => Response.json(citations)
    const limited = service({ db: async () => db, fetch, webSearchRateLimit: { max: 2, windowMs: 60_000 } })
    expect((await limited.websearch(request({ query: "a" }))).status).toBe(200)
    expect((await limited.websearch(request({ query: "b" }))).status).toBe(200)
    const refused = await limited.websearch(request({ query: "c" }))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)

    const own = service({ db: async () => db, fetch, webSearchRateLimit: null })
    for (const query of ["a", "b", "c"]) expect((await own.websearch(request({ query }))).status).toBe(200)
  })

  test("answers 502 when every utility model fails, and an empty list with no citations", async () => {
    expect(
      (
        await service({ fetch: async () => Response.json({ error: "down" }, { status: 500 }) }).websearch(
          request({ query: "x" }),
        )
      ).status,
    ).toBe(502)
    const empty = await service({
      fetch: async () => Response.json({ choices: [{ message: { content: "none" } }] }),
    }).websearch(request({ query: "x" }))
    expect(await empty.json()).toEqual({ results: [] })
    expect(webSearchResults(undefined)).toEqual([])
  })
})
