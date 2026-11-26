/** One token's logprob as a chat completion returns it, with the alternatives `top_logprobs` asked for. */
export type TokenLogprob = {
  readonly token: string
  readonly logprob: number
  readonly bytes?: readonly number[]
  readonly top_logprobs?: readonly {
    readonly token: string
    readonly logprob: number
    readonly bytes?: readonly number[]
  }[]
}

export type VisibleLogprobs = {
  /** The visible text the response streamed, as the capture recorded it. */
  readonly text: string
  /** The tokens that spell that text, in order. */
  readonly tokens: readonly TokenLogprob[]
  /** Whether `tokens` spell all of `text`. False when the provider stopped sending logprobs early. */
  readonly complete: boolean
}

const encoder = new TextEncoder()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payloads(body: string): unknown[] {
  const trimmed = body.trimStart()
  if (trimmed.startsWith("{")) {
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      return []
    }
  }
  const values: unknown[] = []
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice("data:".length).trim()
    if (!data || data === "[DONE]") continue
    try {
      values.push(JSON.parse(data) as unknown)
    } catch {
      // A capture can end mid-line when the call was cancelled.
    }
  }
  return values
}

function tokenBytes(token: TokenLogprob) {
  return token.bytes ? Uint8Array.from(token.bytes) : encoder.encode(token.token)
}

function startsWithAt(haystack: Uint8Array, needle: Uint8Array, at: number) {
  if (at + needle.length > haystack.length) return false
  for (let index = 0; index < needle.length; index++) if (haystack[at + index] !== needle[index]) return false
  return true
}

/**
 * The logprobs of a captured response's visible text, from the raw body a generation capture keeps
 * (`capture.response.body`, streamed or not). Undefined when the response carries none, which some
 * providers do even when asked: count that as missing, not as zero.
 *
 * The raw list is not the visible text. Qwen and DeepSeek start it with the last reasoning tokens
 * up to `</think>`, and end it with special tokens such as `<|im_end|>` or the opening of a tool
 * call, and a streamed chunk's logprobs belong to other tokens than its `delta.content`. So this
 * joins every chunk and keeps the run of tokens whose bytes spell the text.
 */
export function visibleLogprobs(body: string): VisibleLogprobs | undefined {
  let text = ""
  const raw: TokenLogprob[] = []
  for (const value of payloads(body)) {
    if (!record(value) || !Array.isArray(value.choices)) continue
    for (const choice of value.choices) {
      if (!record(choice) || (choice.index !== undefined && choice.index !== 0)) continue
      const delta = record(choice.delta) ? choice.delta : record(choice.message) ? choice.message : undefined
      if (typeof delta?.content === "string") text += delta.content
      const content = record(choice.logprobs) ? choice.logprobs.content : undefined
      if (!Array.isArray(content)) continue
      for (const token of content) {
        if (record(token) && typeof token.token === "string" && typeof token.logprob === "number") {
          raw.push(token as TokenLogprob)
        }
      }
    }
  }
  if (raw.length === 0) return undefined

  const target = encoder.encode(text)
  const pieces = raw.map(tokenBytes)
  const offsets = [0]
  for (const piece of pieces) offsets.push(offsets.at(-1)! + piece.length)
  const joined = new Uint8Array(offsets.at(-1)!)
  pieces.forEach((piece, index) => joined.set(piece, offsets[index]!))

  // Reasoning can end with the same characters the text starts with, so search after its close.
  const think = raw.findIndex((token) => token.token.includes("</think>"))
  for (let first = think + 1; first < raw.length; first++) {
    const start = offsets[first]!
    const covered = target.subarray(0, Math.min(target.length, joined.length - start))
    if (covered.length === 0 || !startsWithAt(joined, covered, start)) continue
    let last = first
    while (last < raw.length && offsets[last + 1]! - start <= target.length) last++
    // DeepSeek streams ".\n\n" as one token before a tool call but trims the line breaks from the
    // text, so the last token can run past the text's end. It still spelled the text's last bytes.
    if (last < raw.length && offsets[last]! - start < target.length) last++
    return { text, tokens: raw.slice(first, last), complete: offsets[last]! - start >= target.length }
  }
  return { text, tokens: [], complete: target.length === 0 }
}
