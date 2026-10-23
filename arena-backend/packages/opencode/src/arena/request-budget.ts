import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Provider } from "@/provider/provider"
import { usable } from "@/session/overflow"
import { Token } from "@/util/token"

export const LIMIT = 272_000
const MEDIA_TOKENS = 4_000

type Request = Pick<LanguageModelV3CallOptions, "prompt" | "tools" | "toolChoice" | "responseFormat">

export class CompactionRequired extends Error {
  constructor() {
    super("Arena request needs compaction")
  }
}

export function estimate(input: Request) {
  let media = 0
  const prompt = input.prompt.map((message) => {
    if (message.role === "system") return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "file") {
          media++
          const { data: _data, ...rest } = part
          return rest
        }
        if (part.type !== "tool-result" || part.output.type !== "content") return part
        return {
          ...part,
          output: {
            ...part.output,
            value: part.output.value.map((item) => {
              if (item.type === "text" || item.type === "custom") return item
              media++
              if (item.type === "file-data" || item.type === "image-data") {
                const { data: _data, ...rest } = item
                return rest
              }
              if (item.type === "file-url" || item.type === "image-url") {
                const { url: _url, ...rest } = item
                return rest
              }
              return item
            }),
          },
        }
      }),
    }
  })
  // Provider-neutral, like the history estimate: a full-request estimate is still not a billed-token cap.
  return Token.estimate(JSON.stringify({ ...input, prompt })) + media * MEDIA_TOKENS
}

export function inputLimit(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  return Math.min(LIMIT, usable(input))
}

export function exceeds(input: Request, limit = LIMIT) {
  return estimate(input) >= limit
}

export function check(input: Request, limit = LIMIT) {
  if (!exceeds(input, limit)) return
  throw new CompactionRequired()
}

export * as ArenaRequestBudget from "./request-budget"
