import { Tiktoken } from "js-tiktoken/lite"
import cl100k from "js-tiktoken/ranks/cl100k_base"
import { eligibleForCompaction } from "./compaction-policy-contract"
import { REDACTED_THINKING } from "./reasoning"

const tokenizer = new Tiktoken(cl100k)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contentTexts(content: unknown) {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => (record(part) && typeof part.text === "string" ? [part.text] : []))
}

function toolTexts(calls: unknown) {
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    if (!record(call) || !record(call.function)) return []
    return [call.function.name, call.function.arguments].filter((text): text is string => typeof text === "string")
  })
}

/** Matches the experiment: text tokens, excluding images, tool schemas and opaque provider state. */
export function reasoningShare(messages: unknown) {
  if (!Array.isArray(messages) || !messages.every(record)) return null
  const texts: string[] = []
  const reasons: string[] = []
  for (const message of messages) {
    texts.push(...contentTexts(message.content), ...toolTexts(message.tool_calls))
    if (message.role !== "assistant") continue
    const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : []
    const detailText = details
      .filter((detail) => record(detail) && detail.type === "reasoning.text" && typeof detail.text === "string")
      .map((detail) => detail.text)
      .join("")
    const reason = message.reasoning || message.reasoning_content || detailText
    if (reason === REDACTED_THINKING) return null
    if (typeof reason === "string" && reason) reasons.push(reason)
    else if (details.length) return null
  }
  // Ordinary text can contain a tokenizer's special-token spelling.
  const reasoning = tokenizer.encode(reasons.join("\n"), [], []).length
  const total = reasoning + tokenizer.encode(texts.join("\n"), [], []).length
  return total ? reasoning / total : null
}

/** An envelope that could not be opened must not become a measured zero. */
export function compactionPolicy(input: Record<string, unknown>, restored: Record<string, unknown>) {
  const original = input.messages
  const messages = restored.messages
  if (!Array.isArray(original) || !Array.isArray(messages)) return { compact: false }
  const missing = original.some((message, index) => {
    if (!record(message) || message.role !== "assistant") return false
    const hadReasoning = message.reasoning || message.reasoning_content || message.reasoning_details
    const opened = messages[index]
    return hadReasoning && record(opened) && !opened.reasoning && !opened.reasoning_content && !opened.reasoning_details
  })
  if (missing) return { compact: false }
  const turns = input.completedUserTurns
  return {
    compact: typeof turns === "number" && eligibleForCompaction(turns, reasoningShare(messages)),
  }
}
