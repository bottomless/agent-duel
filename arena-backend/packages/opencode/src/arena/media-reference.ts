import { createHash } from "crypto"
import {
  MEDIA_UPLOAD_PATH,
  mediaReference,
  mediaUploadRequest,
  readMediaUploadAnswer,
  sendsByReference,
} from "@agent-duel/arena-service/media"
import { MEDIA_UPLOAD_BYTES } from "./engine-runtime/request-size"

/**
 * Sends a hosted contestant request's images and PDFs by reference (arena-service `media.ts`): each
 * file is uploaded once, straight to the control plane's object store, and the request names it
 * instead of carrying its base64. The hosted body limit then leaves the images out of account, so
 * they stay in the prompt and its cache.
 */

export type Media = { readonly digest: string; readonly mimeType: string; readonly data: Buffer }

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,/

// Uploads this process knows the control plane's store keeps, per upstream. The store deletes a file
// 3 days after its upload; a control plane that no longer has one answers `arena_media_missing`, and
// the request uploads it again.
const uploaded = new Set<string>()
// Upstreams that answered the upload route with 404: a control plane older than it, or one with no
// store. Their requests carry their media inline, as before.
const unsupported = new Set<string>()
// Upstreams whose store took an upload. Until one has, the request size counts media inline
// (`request-size.ts`), so a control plane without the route never gets a body over its limit.
const confirmed = new Set<string>()

const key = (upstream: string, digest: string) => `${upstream}|${digest}`

function walkStrings(value: unknown, replace: (text: string) => string | undefined): unknown {
  if (typeof value === "string") return replace(value) ?? value
  if (Array.isArray(value)) return value.map((item) => walkStrings(item, replace))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walkStrings(item, replace)]))
}

/**
 * The body with each image or PDF data URL that an upload URL takes replaced by its reference, and
 * the media it names. A payload Node would not encode back to the same text stays inline, because
 * the proxy rebuilds the data URL from the bytes and the prompt must not change between calls.
 */
export function referenceMedia(body: Readonly<Record<string, unknown>>) {
  const media = new Map<string, Media>()
  const referenced = walkStrings(body, (text) => {
    const match = DATA_URL.exec(text)
    const mimeType = match?.[1]
    if (!match || !mimeType || !sendsByReference(mimeType)) return undefined
    const payload = text.slice(match[0].length)
    const data = Buffer.from(payload, "base64")
    if (data.byteLength === 0 || data.byteLength > MEDIA_UPLOAD_BYTES) return undefined
    if (data.toString("base64") !== payload) return undefined
    const digest = createHash("sha256").update(data).digest("hex")
    if (!media.has(digest)) media.set(digest, { digest, mimeType, data })
    return mediaReference(digest, mimeType)
  }) as Record<string, unknown>
  return { body: referenced, media }
}

export const referencesUnsupported = (upstream: string) => unsupported.has(upstream)

/** Whether the control plane's store took an upload and the route has not answered 404 since. */
export const referencesConfirmed = (upstream: string) => confirmed.has(upstream)

/** The control plane no longer has these; the next upload of each sends it again. */
export function forgetUploads(upstream: string, digests: ReadonlyArray<string>) {
  for (const digest of digests) uploaded.delete(key(upstream, digest))
}

// Uploads run a few at a time: a step that read many screenshots should not wait on each in turn.
const PARALLEL_UPLOADS = 4
// A guess: a file at the size cap takes about this long on a 1 Mbit/s uplink. A storage host that
// never answers must not hold the request; its media goes inline instead.
const UPLOAD_TIMEOUT_MS = 180_000

// The control plane answered without a URL for a file, or the storage host did not take one. In the
// control plane's own shape, so the caller answers it as it would a refused request and the engine
// tries again. Nothing from the storage host is passed on.
const uploadFailed = () =>
  Response.json({ error: { message: "Arena media upload failed", type: "arena_media_upload_failed" } }, { status: 502 })

/**
 * Uploads the media the control plane may not have yet: one request for an upload URL per file, then
 * each file's bytes to its URL. Returns undefined when every upload succeeded, "unsupported" when
 * the control plane has no upload route, or the refusal, which the caller answers as it would the
 * request's own.
 */
export async function uploadMedia(input: {
  readonly execute: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /**
   * Sends a file to its upload URL. Not `execute`: that adds the account's credential, and the
   * storage host gets only the bytes and their type.
   */
  readonly put?: (input: string, init: RequestInit) => Promise<Response>
  readonly upstream: string
  readonly routing: Readonly<Record<string, string>>
  readonly media: Iterable<Media>
  readonly signal: AbortSignal
}): Promise<Response | "unsupported" | undefined> {
  const pending = [...input.media].filter((item) => !uploaded.has(key(input.upstream, item.digest)))
  if (pending.length === 0) return undefined
  const response = await input.execute(`${input.upstream}${MEDIA_UPLOAD_PATH}`, {
    method: "POST",
    headers: { ...input.routing, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(
      mediaUploadRequest(pending.map(({ digest, mimeType, data }) => ({ digest, mimeType, size: data.byteLength }))),
    ),
    signal: input.signal,
  })
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    unsupported.add(input.upstream)
    confirmed.delete(input.upstream)
    return "unsupported"
  }
  if (!response.ok) return response
  const urls = readMediaUploadAnswer(await response.text())
  if (!urls || pending.some((item) => !urls.has(item.digest))) return uploadFailed()
  const put = input.put ?? fetch
  let failed = false
  const next = async (): Promise<void> => {
    const item = pending.shift()
    if (!item || failed) return
    const stored = await put(urls.get(item.digest)!, {
      method: "PUT",
      headers: { "Content-Type": item.mimeType },
      body: new Uint8Array(item.data),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
    }).catch((error: unknown) => {
      if (input.signal.aborted) throw error
      return undefined
    })
    await stored?.body?.cancel().catch(() => undefined)
    if (!stored?.ok) {
      failed = true
      return
    }
    uploaded.add(key(input.upstream, item.digest))
    if (!unsupported.has(input.upstream)) confirmed.add(input.upstream)
    return next()
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, pending.length) }, next))
  return failed ? uploadFailed() : undefined
}
