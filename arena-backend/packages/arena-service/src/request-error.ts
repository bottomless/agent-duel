function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export const contentFilterMessage = "A content filter blocked this response."

// Core recognizes this OpenAI error type as a permanent content-policy failure.
export function contentFilterError() {
  return { error: { type: "content_filter", message: contentFilterMessage } }
}

function json(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const INSPECTION_FAILED_CODE = /^(data_inspection_failed|DataInspectionFailed)$/i

function hasInspectionFailedCode(part: unknown) {
  return (
    isRecord(part) &&
    [part.code, part.type, part.error_type, part.provider_code, part.provider_error_code].some(
      (code) => typeof code === "string" && INSPECTION_FAILED_CODE.test(code),
    )
  )
}

function isInspectionFailedError(error: unknown) {
  if (!isRecord(error)) return false
  const metadata = isRecord(error.metadata) ? error.metadata : undefined
  const raw = typeof metadata?.raw === "string" ? json(metadata.raw) : metadata?.raw
  const nested = isRecord(raw) && isRecord(raw.error) ? raw.error : raw
  return [error, metadata, nested].some(hasInspectionFailedCode)
}

/** Only the service inspects the provider's structured error, never text that may quote the prompt. */
export function inspectionFailed(status: number, body: string) {
  if (status !== 400) return false
  const payload = json(body)
  if (!isRecord(payload)) return false
  return isInspectionFailedError(isRecord(payload.error) ? payload.error : payload)
}

/** Structured `data_inspection_failed` error carried inside an HTTP 200 payload or SSE chunk. */
export function inspectionFailedError(value: unknown) {
  if (!isRecord(value)) return false
  return (
    isInspectionFailedError(value.error) || (isRecord(value.response) && isInspectionFailedError(value.response.error))
  )
}

export function readContentFilter(body: string | undefined) {
  const value = body && json(body)
  return isRecord(value) && isRecord(value.error) && value.error.type === "content_filter"
}

/** Keep answer text sent with the finish, but no policy report, tool call or native reason. */
export function filteredStreamChunk(value: Record<string, unknown>, generationID: string) {
  if (Array.isArray(value.choices)) {
    const choice = value.choices.find(
      (item) =>
        isRecord(item) && (item.finish_reason === "content_filter" || item.native_finish_reason === "content_filter"),
    )
    if (isRecord(choice)) {
      const content = isRecord(choice.delta) ? choice.delta.content : undefined
      return {
        id: generationID,
        choices: [{ index: 0, delta: typeof content === "string" ? { content } : {}, finish_reason: "content_filter" }],
      }
    }
  }
  if (inspectionFailedError(value) || (isRecord(value.error) && value.error.type === "content_filter")) {
    return {
      id: generationID,
      choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
    }
  }
}

/** Whether a complete (non-streamed) response's choice finished on a content filter. */
export function contentFilterFinish(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return false
  return value.choices.some(
    (item) =>
      isRecord(item) && (item.finish_reason === "content_filter" || item.native_finish_reason === "content_filter"),
  )
}

/** Any refusal shape a streamed chunk or a complete response can carry. */
export function contentFilterRefusal(value: unknown) {
  return (
    inspectionFailedError(value) ||
    (isRecord(value) && isRecord(value.error) && value.error.type === "content_filter") ||
    contentFilterFinish(value)
  )
}

/**
 * The usage a refused complete response reported. A chat completion and the service's own neutral
 * refusal keep it at the top level; a nested `/responses` or `data` payload keeps it one level down.
 */
export function refusalUsage(value: unknown) {
  if (!isRecord(value)) return undefined
  return [value, value.response, value.data]
    .map((holder) => (isRecord(holder) ? holder.usage : undefined))
    .find(isRecord)
}

export const compactionRequiredType = "arena_compaction_required"

/**
 * `overflow`: the provider itself refused the context, so the request does not fit as it is. Without it the request
 * crossed the savings threshold and still fits, so the engine summarizes it unchanged. Neither carries a number.
 */
export function compactionRequiredError(overflow = false) {
  return {
    error: {
      message: "Arena request needs compaction",
      type: compactionRequiredType,
      ...(overflow ? { overflow: true } : {}),
    },
  }
}

/** Shown before the vote too: it names no model, and only the voter can shorten the message. */
export const requestTooLargeMessage =
  "This request is too large to process. Reduce the message or attachments and try again."

function compactionRequiredPayload(body: string | undefined) {
  if (!body) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return undefined
  }
  return isRecord(payload) && isRecord(payload.error) && payload.error.type === compactionRequiredType
    ? payload.error
    : undefined
}

/** Reads only the exact neutral type; upstream text and numeric limits are never trusted. */
export function readCompactionRequired(body: string | undefined) {
  return compactionRequiredPayload(body) !== undefined
}

/** Whether a compaction refusal came from the provider refusing the context (see `compactionRequiredError`). */
export function readCompactionOverflow(body: string | undefined) {
  return compactionRequiredPayload(body)?.overflow === true
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
/**
 * The control plane refuses a single-agent prompt's first model call with this code once the account
 * has used its allowance. Twin of `SINGLE_AGENT_ALLOWANCE_*` in `packages/protocol/src/accounts/schemas.ts`,
 * which words the same refusal when the prompt's assignment is created.
 */
export const singleAgentAllowanceCode = "single_agent_allowance"
export const singleAgentAllowanceMessage =
  "Arena single-agent limit reached. Review and vote on battles to add to it, or try again later."

export function singleAgentAllowanceError() {
  return { error: { message: singleAgentAllowanceMessage, type: singleAgentAllowanceCode } }
}

export function readSingleAgentAllowance(body: string | undefined) {
  if (!body) return false
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return false
  }
  return isRecord(payload) && payload.code === singleAgentAllowanceCode
}

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

// A contestant request answers 401 with this when the control plane refused the user's session,
// which only a new sign-in fixes. The engine waits for it, as for the network. The daemon's runtime
// proxy writes the same body (`packages/server/src/server/accounts/arena-runtime-router.ts`).
export const sessionRejectedType = "arena_session_rejected"

/** The retry status while a contestant waits for a new sign-in. The app labels it by this text. */
export const SESSION_REJECTED_RETRY_MESSAGE = "Waiting for sign-in"

export function sessionRejectedError() {
  return { error: { message: "Arena session was rejected", type: sessionRejectedType } }
}

export function readSessionRejected(body: string | undefined) {
  if (!body) return false
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return false
  }
  return isRecord(payload) && isRecord(payload.error) && payload.error.type === sessionRejectedType
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

/** Only a BYOK caller may attribute a rejected key to the user. */
export function runAuthMessage(error: string) {
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
    if (payload.data.statusCode === 401) return "OpenRouter rejected your key. Check the key in Settings."
  }
  return undefined
}
