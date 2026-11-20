import { MEDIA_REFERENCE } from "./generation-capture"

/**
 * Media a hosted contestant request carries by reference. Vercel refuses a function request over
 * about 4.5 MB, and a chat that reads screenshots sends every one again on every call. Leaving the
 * oldest out to fit rewrote the prompt prefix, which costs Claude a full cache write each time. So
 * the engine uploads each image or PDF once to `MEDIA_PATH`, the request names it with
 * `mediaReference`, and the proxy puts the data back before OpenRouter sees the body. Media is
 * stored per account, keyed by the SHA-256 of its bytes, for 72 hours (`generation-capture.ts`).
 */
export const MEDIA_PATH = "/api/v1/arena/media"
/** The upload's media type; its body is the raw bytes. */
export const MEDIA_TYPE_HEADER = "x-arena-media-type"
const MEDIA_MISSING_TYPE = "arena_media_missing"

export { MEDIA_REFERENCE }

/** Images and PDFs: what a contestant request carries as base64 data URLs. */
export function sendsByReference(mimeType: string) {
  const type = mimeType.toLowerCase()
  return type.startsWith("image/") || type === "application/pdf"
}

export function mediaReference(digest: string, mimeType: string) {
  return `${MEDIA_REFERENCE}${digest}:${mimeType}`
}

/** The proxy has no media for these references; the engine uploads them and sends the request again. */
export function mediaMissingError(missing: ReadonlyArray<string>) {
  return { error: { message: "Arena media is missing", type: MEDIA_MISSING_TYPE, missing: [...missing] } }
}

/** The request names more media than any provider takes. Refused before it is built, not retried. */
export function mediaTooLargeError() {
  return { error: { message: "Arena request carries too much media", type: "arena_media_too_large" } }
}

/** The digests a `mediaMissingError` body names, or undefined for any other body. */
export function readMediaMissing(body: string | undefined) {
  if (!body) return undefined
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; missing?: unknown } } | null)?.error
    if (error?.type !== MEDIA_MISSING_TYPE || !Array.isArray(error.missing)) return undefined
    return error.missing.filter((digest): digest is string => typeof digest === "string")
  } catch {
    return undefined
  }
}
