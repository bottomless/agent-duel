import { createHash } from "crypto"
import type { ArenaCollection, ArenaDb } from "./collection"
import { authorize, type ArenaContext } from "./context"
import { requestUtilityModel } from "./utility-model"

// Web search for contestants and chats, through OpenRouter's `web` plugin on the comparison's utility
// model. The engine sends only the query; OpenRouter picks its default search engine (the model's
// native search where it has one, otherwise Exa), runs the search, and returns the results as URL
// citations. The model's own reply is not used, so it is capped to a few tokens. The search runs on
// the hosted key, so the route is limited per account.

export const MAX_WEB_SEARCH_QUERY_CHARS = 400
export const WEB_SEARCH_RESULTS = 8

export type WebSearchRateLimit = {
  readonly max: number
  readonly windowMs: number
}

export const defaultWebSearchRateLimit: WebSearchRateLimit = { max: 200, windowMs: 60 * 60_000 }

export type WebSearchResult = {
  readonly url: string
  readonly title?: string
  readonly content?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseQuery(value: unknown) {
  if (!record(value) || typeof value.query !== "string") return undefined
  if (Object.keys(value).some((key) => key !== "query")) return undefined
  const query = value.query.trim()
  if (!query || query.length > MAX_WEB_SEARCH_QUERY_CHARS) return undefined
  return query
}

type LimitDocument = {
  readonly _id: string
  readonly userId: string
  readonly window: number
  readonly count: number
}

function limits(db: ArenaDb): ArenaCollection<LimitDocument> {
  return db.collection<LimitDocument>("arenaWebSearchLimits")
}

/** Counts a search against the caller's window and answers whether it is within the limit. */
async function admit(db: ArenaDb, userId: string, limit: WebSearchRateLimit, now: Date) {
  const window = Math.floor(now.getTime() / limit.windowMs)
  const _id = createHash("sha256").update(`${userId.length}:${userId}|websearch`).digest("hex")
  const counted = await limits(db).findOneAndUpdate(
    { _id, window },
    { $inc: { count: 1 } },
    { returnDocument: "after" },
  )
  if (counted) return counted.count <= limit.max
  // A new window replaces the last one, so each account keeps one document. Two searches that
  // open a window at once can both start it at one, which lets one extra through.
  await limits(db).replaceOne({ _id }, { _id, userId, window, count: 1 }, { upsert: true })
  return limit.max >= 1
}

/** The URL citations of an OpenRouter chat completion, once per URL, in order. */
export function webSearchResults(value: unknown): WebSearchResult[] {
  if (!record(value) || !Array.isArray(value.choices) || !record(value.choices[0])) return []
  const message = value.choices[0].message
  if (!record(message) || !Array.isArray(message.annotations)) return []
  const seen = new Set<string>()
  const results: WebSearchResult[] = []
  for (const annotation of message.annotations) {
    if (!record(annotation) || annotation.type !== "url_citation" || !record(annotation.url_citation)) continue
    const citation = annotation.url_citation
    if (typeof citation.url !== "string" || !/^https?:\/\//i.test(citation.url) || seen.has(citation.url)) continue
    seen.add(citation.url)
    results.push({
      url: citation.url,
      ...(typeof citation.title === "string" && citation.title.trim() ? { title: citation.title.trim() } : {}),
      ...(typeof citation.content === "string" && citation.content.trim() ? { content: citation.content.trim() } : {}),
    })
  }
  return results
}

export async function handleWebSearchRequest(request: Request, context: ArenaContext) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
  const caller = await authorize(request, context, (message, status) => Response.json({ error: message }, { status }))
  if (caller instanceof Response) return caller
  const apiKey = context.openRouterApiKey
  if (!apiKey) return Response.json({ error: "Arena web search is unavailable" }, { status: 503 })

  let parsed: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_WEB_SEARCH_QUERY_CHARS * 4 + 100) {
      return Response.json({ error: "Arena web search request is too large" }, { status: 413 })
    }
    parsed = JSON.parse(text)
  } catch {
    return Response.json({ error: "Arena web search request is invalid" }, { status: 400 })
  }
  const query = parseQuery(parsed)
  if (!query) return Response.json({ error: "Arena web search request is invalid" }, { status: 400 })

  const limit = context.webSearchRateLimit
  if (limit) {
    let allowed: boolean
    try {
      allowed = await admit(await context.db(), caller.id, limit, context.now())
    } catch (error) {
      console.error("[arena-service] Arena web search limit could not be read", error)
      return Response.json({ error: "Arena web search is unavailable" }, { status: 503 })
    }
    if (!allowed) {
      const retryAfter = Math.ceil((limit.windowMs - (context.now().getTime() % limit.windowMs)) / 1000)
      return Response.json(
        { error: "Too many Arena web searches" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      )
    }
  }

  try {
    const response = await requestUtilityModel(context, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: {
        messages: [{ role: "user", content: query }],
        // No engine: OpenRouter's default, which is the model's native search or Exa.
        plugins: [{ id: "web", max_results: WEB_SEARCH_RESULTS }],
        max_tokens: 16,
      },
      signal: request.signal,
    })
    if (!response.ok) {
      console.error(`[arena-service] Arena web search failed with status ${response.status}`)
      return Response.json({ error: "Arena web search failed" }, { status: 502 })
    }
    return Response.json({ results: webSearchResults(await response.json()) })
  } catch {
    console.error("[arena-service] Arena web search failed")
    return Response.json({ error: "Arena web search failed" }, { status: 502 })
  }
}
