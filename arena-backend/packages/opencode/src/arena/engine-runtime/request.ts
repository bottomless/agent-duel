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

export * as ArenaEngineRequest from "./request.js"
