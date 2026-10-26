import { randomUUID } from "node:crypto"

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
}) {
  return {
    "x-session-affinity": input.sessionID,
    "X-Session-Id": input.sessionID,
    "x-arena-session-id": input.sessionID,
    "x-arena-root-session-id": input.rootSessionID ?? input.sessionID,
    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
    ...(input.parentSessionID ? { "x-arena-parent-session-id": input.parentSessionID } : {}),
    "x-arena-request-id": randomUUID(),
    "x-arena-generation-classification": classification(input.kind),
  }
}

export function promptCacheKey(sessionID: string) {
  return /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID
}

/** Arena's provider-neutral preflight ceiling, below either model catalog window. */
export const REQUEST_TOKEN_LIMIT = 272_000

const MEDIA_TOKENS = 4_000

/** Remove opaque media payloads before estimating; each item receives the settled media allowance. */
function stripMedia(value: unknown): { readonly value: unknown; readonly media: number } {
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
  const mediaPayload = type === "file" || type === "image" || type === "file-data" || type === "image-data"
  const urlPayload = type === "file-url" || type === "image-url"
  let media = mediaPayload || urlPayload ? 1 : 0
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if ((mediaPayload && key === "data") || (urlPayload && key === "url")) continue
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

export * as ArenaEngineRequest from "./request.js"
