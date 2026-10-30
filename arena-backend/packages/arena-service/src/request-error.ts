function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export const compactionRequiredType = "arena_compaction_required"

export function compactionRequiredError() {
  return { error: { message: "Arena request needs compaction", type: compactionRequiredType } }
}

/** Shown before the vote too: it names no model, and only the voter can shorten the message. */
export const requestTooLargeMessage =
  "This request is too large to process. Reduce the message or attachments and try again."

/** Reads only the exact neutral type; upstream text and numeric limits are never trusted. */
export function readCompactionRequired(body: string | undefined) {
  if (!body) return false
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return false
  }
  return isRecord(payload) && isRecord(payload.error) && payload.error.type === compactionRequiredType
}

/**
 * Recognizes provider context refusals while keeping their model and numeric details private. Only
 * phrases about the context are matched: a quota or output-cap error that mentions tokens must reach
 * the voter as itself, not start a paid summary.
 */
export function isContextOverflow(status: number | undefined, body: string | undefined) {
  if (status !== 400 && status !== 413 && status !== 422) return false
  if (!body) return false
  const text = body.toLowerCase()
  return [
    "context_length_exceeded",
    "context length",
    "context window",
    "maximum context",
    "prompt is too long",
    "input is too long",
    "request is too long",
  ].some((signal) => text.includes(signal))
}

// Keep billing categories for retry decisions, but do not expose billing details in UI copy.
export const paymentMessages = {
  arena_temporary_budget: "The agent is temporarily unavailable. Please try again later.",
  arena_credit_limit: "The agent could not complete this run.",
  arena_payment_required: "The agent could not complete this run.",
} as const

export type PaymentErrorCode = keyof typeof paymentMessages

export function retryableStreamError(value: unknown) {
  const code = isRecord(value) ? value.code : undefined
  if (typeof code === "number") return code === 408 || code === 429 || code >= 500
  if (typeof code !== "string") return true
  const status = Number(code)
  if (Number.isInteger(status)) return status === 408 || status === 429 || status >= 500
  return new Set([
    "server_error",
    "server_is_overloaded",
    "rate_limit_exceeded",
    "timeout",
    "gateway_timeout",
    "connection_error",
  ]).has(code.toLowerCase())
}

export function paymentError(code: PaymentErrorCode) {
  return { error: { code, message: paymentMessages[code], type: "arena_upstream_error" } }
}

// Only the control plane reads provider metadata. Local consumers accept the
// closed set of neutral codes, never upstream messages or remedy hints.
export function classifyPaymentError(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error) || !isRecord(payload.error.metadata)) {
    return paymentError("arena_payment_required")
  }
  switch (payload.error.metadata.limit_source) {
    case "openrouter_in_flight_budget":
      return paymentError("arena_temporary_budget")
    case "openrouter_key_limit":
    case "openrouter_credits":
      return paymentError("arena_credit_limit")
    default:
      return paymentError("arena_payment_required")
  }
}

export function readPaymentError(body: string | undefined): PaymentErrorCode | undefined {
  if (!body) return
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return
  }
  if (!isRecord(payload) || !isRecord(payload.error)) return
  const code = payload.error.code
  if (code === "arena_temporary_budget" || code === "arena_credit_limit" || code === "arena_payment_required") {
    return code
  }
}

// A contestant request answers 503 with this when the user's machine has no network. The engine
// waits for the network instead of spending the run's retry budget. The daemon's runtime proxy
// writes the same body (`packages/server/src/server/accounts/network-unavailable.ts`).
export const networkUnavailableType = "arena_network_unavailable"

export function networkUnavailableError() {
  return { error: { message: "Arena network is unavailable", type: networkUnavailableType } }
}

export function readNetworkUnavailable(body: string | undefined) {
  if (!body) return false
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return false
  }
  return isRecord(payload) && isRecord(payload.error) && payload.error.type === networkUnavailableType
}

export function paymentMessage(status: number | undefined, body: string | undefined) {
  if (status !== 402) return
  return paymentMessages[readPaymentError(body) ?? "arena_payment_required"]
}

export function runPaymentMessage(error: string) {
  const prefix = "Contestant assistant error: "
  for (const line of error.split("\n")) {
    if (!line.startsWith(prefix)) continue
    let payload: unknown
    try {
      payload = JSON.parse(line.slice(prefix.length))
    } catch {
      continue
    }
    if (!isRecord(payload) || payload.name !== "APIError" || !isRecord(payload.data)) continue
    const body = typeof payload.data.responseBody === "string" ? payload.data.responseBody : undefined
    if (payload.data.statusCode === 402) return paymentMessage(402, body)
  }
}
