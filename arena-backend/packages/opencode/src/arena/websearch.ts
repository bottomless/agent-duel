import { MAX_WEB_SEARCH_QUERY_CHARS, type WebSearchResult } from "@agent-duel/arena-service/websearch"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ArenaRuntime, backend } from "./runtime"

/**
 * OpenCode 2.0's web search asks the user to pick a search provider and to agree to send the query
 * to it, on a form Agent Duel never shows, so every search failed after a minute with "Web search
 * cancelled" (bench 2026-11-06). Agent Duel answers that choice with one provider of its own:
 * OpenRouter, through the same backend as the battle routes (the control plane when hosted, the
 * in-process service with the user's key when BYOK), so a search needs no other account or key.
 * The query reaches OpenRouter and its default search engine; nothing names the model or the side.
 */
export const PROVIDER_ID = "openrouter"
export const PROVIDER_NAME = "OpenRouter"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function results(value: unknown): WebSearchResult[] {
  if (!record(value) || !Array.isArray(value.results)) return []
  return value.results.flatMap((result) => {
    if (!record(result) || typeof result.url !== "string") return []
    return [
      {
        url: result.url,
        ...(typeof result.title === "string" ? { title: result.title } : {}),
        ...(typeof result.content === "string" ? { content: result.content } : {}),
      },
    ]
  })
}

export async function search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const target = backend()
  if (!target) throw new Error("Arena web search credentials are unavailable")
  const response = await target.fetch(`${target.url}/api/arena/websearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query.trim().slice(0, MAX_WEB_SEARCH_QUERY_CHARS) }),
    signal,
  })
  if (response.status === 429) throw new Error("Web search rate limited (HTTP 429)")
  if (!response.ok) throw new Error(`Arena web search failed with status ${response.status}`)
  return results(await response.json().catch(() => undefined))
}

/**
 * Adds the OpenRouter provider and makes it the default, which wins over a stored choice, so the
 * provider form never opens. Its own plugin, beside the engine plugin, so search stays one concern.
 */
export function createArenaWebSearchPlugin(options: { readonly enabled?: () => boolean } = {}) {
  return define({
    id: "arena.websearch",
    effect: (context) =>
      Effect.gen(function* () {
        if (!(options.enabled ?? ArenaRuntime.enabled)()) return
        yield* context.websearch.transform((editor) => {
          editor.add({
            id: PROVIDER_ID,
            name: PROVIDER_NAME,
            execute: (input) =>
              Effect.tryPromise({
                try: (signal) => search(input.query, signal),
                catch: (error) => error,
              }).pipe(Effect.map((results) => results.map((result) => ({ ...result, time: {} })))),
          })
          editor.default.set(PROVIDER_ID)
        })
      }),
  })
}

export * as ArenaWebSearch from "./websearch"
