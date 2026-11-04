import type { ContentPart, Message, ProviderMetadata } from "@opencode/ai"
import type { SessionMessage } from "@opencode/schema/session-message"
import { REDACTED_THINKING } from "@agent-duel/arena-service/reasoning"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Only call at an assignment/scope boundary. Text and tool payloads never pass through this cleaner.
function expiredState(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith("arena_reasoning_v1.") ? undefined : value
  if (Array.isArray(value)) {
    const kept = value.map(expiredState).filter((item) => item !== undefined)
    if (kept.every((item, index) => item === value[index]) && kept.length === value.length) return value
    return kept.length ? kept : undefined
  }
  if (!record(value)) return value
  if (value.id === "arena_redacted_thinking") return undefined
  if (
    value.type === "reasoning.encrypted" &&
    typeof value.data === "string" &&
    value.data.startsWith("arena_reasoning_v1.")
  )
    return undefined
  const entries = Object.entries(value)
  const cleaned = entries.map(([key, item]) => [key, expiredState(item)] as const)
  if (cleaned.every(([, item], index) => item === entries[index][1])) return value
  const kept = Object.fromEntries(cleaned.filter(([, item]) => item !== undefined))
  return Object.keys(kept).length ? kept : undefined
}

function expireState(state: Record<string, unknown> | undefined) {
  const kept = expiredState(state)
  return record(kept) ? kept : undefined
}

/** Copies cross assignments; the source must retain replay state for retry and Resume. */
export function expireCopiedReasoning(message: SessionMessage.Info): SessionMessage.Info {
  if (message.type !== "assistant" || message.model.providerID !== "arena") return message
  return {
    ...message,
    providerState: expireState(message.providerState),
    content: message.content.map((part) =>
      part.type === "tool"
        ? {
            ...part,
            providerState: expireState(part.providerState),
            providerResultState: expireState(part.providerResultState),
          }
        : { ...part, state: expireState(part.state) },
    ),
  }
}

function expireMetadata(metadata: ProviderMetadata | undefined): ProviderMetadata | undefined {
  if (metadata === undefined) return undefined
  const kept: Record<string, Record<string, unknown>> = {}
  for (const [provider, state] of Object.entries(metadata)) {
    const next = expireState(state)
    if (next !== undefined) kept[provider] = next
  }
  return Object.keys(kept).length ? kept : undefined
}

/** Battle-off changes scope on each prompt. Do not mutate its canonical rows or transcript hash. */
export function reasoningContext(messages: Message[], fromMessageID?: string): Message[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message]
    const expired = fromMessageID !== undefined && message.id !== undefined && String(message.id) < fromMessageID
    const content = message.content.flatMap((part): ContentPart[] => {
      if (!expired) return [part]
      if (part.type === "reasoning" && part.text.replaceAll(REDACTED_THINKING, "").trim() === "") return []
      if (!("providerMetadata" in part)) return [part]
      return [{ ...part, providerMetadata: expireMetadata(part.providerMetadata) }]
    })
    // Moonshot rejects an assistant with no reply or tool call, even if reasoning remains.
    const hasReply = content.some(
      (part) => part.type !== "reasoning" && (part.type !== "text" || part.text.trim().length > 0),
    )
    return hasReply ? [{ ...message, content }] : []
  })
}
