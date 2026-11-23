const TESTED_MODELS = new Set(["google/gemini-4-carbon", "google/gemini-4-carbon-20261110"])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Carbon on AI Studio can reject a plain-text tool result but accept the identical text in an
 * output object. Only this exact refusal was replayed successfully; other 400s must keep their
 * existing handling. The caller permits one retry, before any response reaches the client.
 */
export async function geminiToolResultRetry(request: Record<string, unknown>, response: Response) {
  if (typeof request.model !== "string" || !TESTED_MODELS.has(request.model)) return undefined
  if (response.status !== 400 || !Array.isArray(request.messages)) return undefined
  const refusal = await response
    .clone()
    .text()
    .catch(() => undefined)
  if (refusal === undefined) return undefined
  const payload = json(refusal)
  if (!record(payload) || !record(payload.error) || payload.error.code !== 400) return undefined
  const metadata = payload.error.metadata
  if (!record(metadata) || metadata.provider_name !== "Google AI Studio" || typeof metadata.raw !== "string") {
    return undefined
  }
  const raw = json(metadata.raw)
  if (!record(raw) || !record(raw.error)) return undefined
  const error = raw.error
  if (
    error.code !== 400 ||
    error.status !== "INVALID_ARGUMENT" ||
    error.message !== "Request contains an invalid argument."
  ) {
    return undefined
  }

  const messages: unknown[] = [...request.messages]
  let changed = false
  // Only the pending tool-result batch changes. Earlier history and signed assistant calls stay intact.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!record(message) || message.role !== "tool") break
    const content = message.content
    // JSON values, image/content blocks, and empty outputs retain their original representation.
    if (typeof content !== "string" || !content.trim() || json(content) !== undefined) continue
    messages[index] = { ...message, content: JSON.stringify({ output: content }) }
    changed = true
  }
  if (!changed) return undefined
  return { request: { ...request, messages }, refusal }
}
