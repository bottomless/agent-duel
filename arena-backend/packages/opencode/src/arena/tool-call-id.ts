import { createHash } from "node:crypto"

// Native /api history used 20 hex digits; Arena transcript projections used 32. Only pass through
// those exact shapes: a provider-supplied ID can start with `call_arena_` too.
const blinded = /^call_arena_(?:[0-9a-f]{20}|[0-9a-f]{32})$/

export function hashCallID(id: string, ...scope: (string | number)[]) {
  const source = scope.length ? JSON.stringify([id, ...scope]) : id
  return `call_arena_${createHash("sha256").update(source).digest("hex").slice(0, 32)}`
}

export function blindCallID(id: string, scope?: string) {
  if (blinded.test(id)) return id
  return scope === undefined ? hashCallID(id) : hashCallID(id, scope)
}

/** The same owner on a native history row, a tool lifecycle event, and a projected part or permission. */
export function callMessageID(value: Record<string, unknown>) {
  if (typeof value.assistantMessageID === "string") return value.assistantMessageID
  if (typeof value.messageID === "string") return value.messageID
  if ((value.type === "assistant" || value.role === "assistant") && typeof value.id === "string") return value.id
  return undefined
}
