import type { ArenaContext } from "./context"

// The comparison and the metadata text run on a cheap, fast model, tried in this order. Each entry
// pins one provider, because the reasoning setting is tuned per provider: Baseten ignores
// `effort: low` and reasons for thousands of tokens, so DeepSeek runs with reasoning off.
export const utilityModels = [
  {
    id: "qwen/qwen3.8-27b",
    provider: "cerebras",
    reasoning: { effort: "low" },
    routing: { order: ["cerebras"], allow_fallbacks: false, require_parameters: true },
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    provider: "baseten",
    reasoning: { enabled: false },
    routing: { order: ["baseten"], allow_fallbacks: false, require_parameters: true },
  },
] as const

/**
 * Sends one chat completion to the first utility model that accepts it. Any failure status or
 * network error moves on to the next model; the last model's answer is returned as it is. A
 * response that has started streaming is never retried.
 */
export async function requestUtilityModel(
  context: Pick<ArenaContext, "fetch">,
  input: {
    readonly headers: Record<string, string>
    readonly body: Record<string, unknown>
    readonly signal: AbortSignal
  },
) {
  for (const [index, model] of utilityModels.entries()) {
    const last = index === utilityModels.length - 1
    try {
      const response = await context.fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify({
          model: model.id,
          ...input.body,
          reasoning: model.reasoning,
          provider: model.routing,
        }),
        signal: input.signal,
      })
      if (response.ok || last) return response
      await response.body?.cancel().catch(() => undefined)
      console.error(`[arena-service] Utility model ${model.id} failed with status ${response.status}`)
    } catch (error) {
      if (last || input.signal.aborted) throw error
      console.error(`[arena-service] Utility model ${model.id} failed`)
    }
  }
  throw new Error("No utility model is configured")
}
