import { randomUUID } from "node:crypto"
import { COMPACTION_HEADER, COMPACTION_OFFER } from "@agent-duel/arena-service/request-budget"
import { readCompactionRequired, requestTooLargeMessage } from "@agent-duel/arena-service/request-error"

export type RequestClassification = "generation" | "compaction" | "utility"

export function classification(kind: "primary" | "compaction" | "title" | "generate"): RequestClassification {
  if (kind === "compaction") return "compaction"
  if (kind === "primary") return "generation"
  return "utility"
}

export function requestHeaders(input: {
  readonly sessionID: string
  readonly kind: "primary" | "compaction" | "title" | "generate"
  readonly parentSessionID?: string
  readonly rootSessionID?: string
  readonly requestID?: string
  readonly arenaCompaction?: boolean
}) {
  return {
    ...(input.kind === "primary" && input.arenaCompaction ? { [COMPACTION_HEADER]: COMPACTION_OFFER } : {}),
    "x-session-affinity": input.sessionID,
    "X-Session-Id": input.sessionID,
    "x-arena-session-id": input.sessionID,
    "x-arena-root-session-id": input.rootSessionID ?? input.sessionID,
    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
    ...(input.parentSessionID ? { "x-arena-parent-session-id": input.parentSessionID } : {}),
    "x-arena-request-id": input.requestID ?? randomUUID(),
    "x-arena-generation-classification": classification(input.kind),
  }
}

/**
 * One request ID per logical model request. Core rebuilds a step's request for each retry and runs
 * `model.request` again, and telemetry counts a retry only when an ID arrives twice, so a fresh ID
 * per call recorded no retries at all. A primary request that follows a scheduled retry reuses the ID
 * of the primary request it replaces.
 *
 * Compaction resends its own prepared request, headers included, on each of its retries, so it never
 * needs the mark: every compaction gets a fresh ID, and it ends the primary request before it (the
 * step restarts under a new assistant message after a summary). Title and generate requests always
 * get a fresh ID and leave the session's state alone.
 *
 * The mark is set when Core decides to retry, and a decision is not always followed by the retried
 * request: a cancel can end the wait, and a step can still fail on an interrupted tool. So the mark
 * lapses once its wait is over by `RETRY_MARK_SLACK_MS`, and whatever starts the session again inside
 * that window without the retried request (a cancel, a manual Retry, a new subagent task) clears it
 * with `reset`. New input to a busy session (a steer) does not: the retry still goes out.
 */
export function requestIdentity(now: () => number = Date.now) {
  const lastPrimary = new Map<string, string>()
  const retrying = new Map<string, number>()
  return {
    next(sessionID: string, kind: "primary" | "compaction" | "title" | "generate") {
      if (kind === "title" || kind === "generate") return randomUUID()
      const previous = lastPrimary.get(sessionID)
      const until = retrying.get(sessionID)
      retrying.delete(sessionID)
      if (kind === "compaction") {
        lastPrimary.delete(sessionID)
        return randomUUID()
      }
      const retried = until !== undefined && now() <= until
      const requestID = retried && previous !== undefined ? previous : randomUUID()
      lastPrimary.set(sessionID, requestID)
      return requestID
    },
    /** Core decided to send the session's last primary request again after `delayMs`. */
    retryScheduled(sessionID: string, delayMs: number) {
      if (lastPrimary.has(sessionID)) retrying.set(sessionID, now() + Math.max(0, delayMs) + RETRY_MARK_SLACK_MS)
    },
    /** The session starts again without the retried request, so the next request is a new one. */
    reset(sessionID: string) {
      retrying.delete(sessionID)
    },
  }
}

/**
 * How long after its wait a retry mark still claims the next request. The resend first reloads the
 * session's context, which takes well under this; a decision that was never sent lapses after it.
 */
export const RETRY_MARK_SLACK_MS = 30_000

/** The engine's request IDs. Session IDs are unique across locations, so one instance serves them all. */
export const sessionRequestIDs = requestIdentity()

/** Call before resuming a session that failed, so its next request does not count as a retry. */
export function forgetScheduledRetry(sessionID: string) {
  sessionRequestIDs.reset(sessionID)
}

export function promptCacheKey(sessionID: string) {
  return /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID
}

/** Fallback for a control plane that does not answer with a model-specific compaction refusal. */
export const REQUEST_TOKEN_LIMIT = 272_000

const MEDIA_TOKENS = 4_000

const DATA_URI = /^data:[^,]*;base64,/i

/** Media part types and the keys that hold their payload, for 1.x AI SDK and 2.0 request shapes. */
const PAYLOAD_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["file", new Set(["data", "url", "uri"])],
  ["image", new Set(["data", "url", "uri"])],
  ["file-data", new Set(["data"])],
  ["image-data", new Set(["data"])],
  ["file-url", new Set(["url"])],
  ["image-url", new Set(["url"])],
  // The whole 2.0 `media` asset is opaque: its source holds base64, bytes, or a URL the provider fetches.
  ["media", new Set(["media"])],
  // A 2.0 `Media.Source` outside a media part, such as its JSON form.
  ["base64", new Set(["data"])],
  ["bytes", new Set(["data"])],
])

/**
 * Remove opaque media payloads before estimating; each item receives the settled media allowance.
 * OpenCode 2 sends a user image as `{ type: "media", media: Asset }` and a tool image as
 * `{ type: "file", uri: "data:…;base64,…" }`; any other inline base64 or binary is charged the same.
 */
function stripMedia(value: unknown): { readonly value: unknown; readonly media: number } {
  if (typeof value === "string") return DATA_URI.test(value) ? { value: "", media: 1 } : { value, media: 0 }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { value: null, media: 1 }
  if (Array.isArray(value)) {
    let media = 0
    const items = value.map((item) => {
      const stripped = stripMedia(item)
      media += stripped.media
      return stripped.value
    })
    return { value: items, media }
  }
  if (typeof value !== "object" || value === null) return { value, media: 0 }
  const source = value as Record<string, unknown>
  const type = typeof source.type === "string" ? source.type : ""
  const payload = PAYLOAD_KEYS.get(type)
  let media = payload ? 1 : 0
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (payload?.has(key)) continue
    const stripped = stripMedia(item)
    media += stripped.media
    result[key] = stripped.value
  }
  return { value: result, media }
}

/** Estimate a provider-neutral request, charging media by allowance instead of encoded bytes. */
export function requestTokenEstimate(request: unknown) {
  const stripped = stripMedia(request)
  return Math.round(JSON.stringify(stripped.value).length / 4) + stripped.media * MEDIA_TOKENS
}

export function requestNeedsCompaction(request: unknown) {
  return requestTokenEstimate(request) >= REQUEST_TOKEN_LIMIT
}

/** A first request and the request immediately after a checkpoint have no older exchange to shrink. */
export function canCompactHistory(
  messages: readonly { readonly type: string; readonly status?: string; readonly finish?: string }[],
) {
  const last = messages.findLast(
    (message) =>
      (message.type === "assistant" && message.finish !== undefined) ||
      (message.type === "compaction" && message.status === "completed"),
  )
  return last?.type === "assistant"
}

/** Translate only the control plane's neutral refusal into Core's native overflow recovery signal. */
export async function compactionResponse(
  response: Response,
  request: Request,
  kind: "primary" | "compaction" | "title" | "generate",
) {
  if (response.status !== 413 || !readCompactionRequired(await response.clone().text())) return response
  const compact =
    kind === "compaction" || (kind === "primary" && request.headers.get(COMPACTION_HEADER) === COMPACTION_OFFER)
  return Response.json(
    {
      error: {
        message: requestTooLargeMessage,
        // Core recognizes this provider error code before publishing a failed step. An irreducible
        // request keeps a payload refusal, so it cannot start another paid summary.
        code: compact ? "context_length_exceeded" : "arena_irreducible_input",
        type: "arena_compaction_required",
      },
    },
    { status: 413 },
  )
}

export * as ArenaEngineRequest from "./request.js"
