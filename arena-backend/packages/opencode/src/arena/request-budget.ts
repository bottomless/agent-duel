import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { Token } from "@/util/token"

export const LIMIT = 272_000
export const EXCEEDED =
  "The request exceeds the context budget. Reduce attached context or enabled tools and try again."
const MEDIA_TOKENS = 4_000

type Request = Pick<LanguageModelV3CallOptions, "prompt" | "tools" | "toolChoice" | "responseFormat">

export class CompactionRequired extends Error {
  constructor() {
    super("Arena request needs compaction")
  }
}

export class RequestTooLarge extends Error {
  constructor() {
    super(EXCEEDED)
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

export function exceeds(input: Request) {
  return estimate(input) >= LIMIT
}

export function check(input: Request, action: "compact" | "stop") {
  if (!exceeds(input)) return
  if (action === "compact") throw new CompactionRequired()
  throw new RequestTooLarge()
}

export * as ArenaRequestBudget from "./request-budget"
