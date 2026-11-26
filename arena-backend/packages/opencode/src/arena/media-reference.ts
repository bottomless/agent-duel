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
// 3 to 4 days after its upload; a control plane that no longer has one answers `arena_media_missing`,
// and the request uploads it again.
const uploaded = new Set<string>()
// Upstreams that answered the upload route with 404: a control plane older than it, or one with no
// store. Their requests carry their media inline, as before.
const unsupported = new Set<string>()
// Upstreams whose store took an upload. Until one has, the request size counts media inline
// (`request-size.ts`), so a control plane without the route never gets a body over its limit.
const confirmed = new Set<string>()
// Upstreams whose store failed an upload, or could not read back a file it had just taken, with
// when to try it again. Their requests carry media inline until then, so a storage host that stops
// answering holds one step, not every step. A guess: long enough to outlast a short outage, short
// enough that a chat goes back to references while it runs.
const paused = new Map<string, number>()
const STORE_PAUSE_MS = 5 * 60 * 1000

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

/**
 * Whether this upstream's requests carry their media inline: its control plane has no upload route,
 * or its store failed a few minutes ago.
 */
export const sendsInline = (upstream: string) => unsupported.has(upstream) || (paused.get(upstream) ?? 0) > Date.now()

/** Whether the control plane's store took an upload and has not failed or answered 404 since. */
export const referencesConfirmed = (upstream: string) => confirmed.has(upstream)

/**
 * Sends this upstream's media inline for a while, and sizes its requests for that, because its store
 * failed. The request that found it sends inline when its body fits, and otherwise fails in a way
 * the engine retries.
 */
export function pauseReferences(upstream: string) {
  paused.set(upstream, Date.now() + STORE_PAUSE_MS)
  confirmed.delete(upstream)
}

/** The control plane no longer has these; the next upload of each sends it again. */
export function forgetUploads(upstream: string, digests: ReadonlyArray<string>) {
  for (const digest of digests) uploaded.delete(key(upstream, digest))
}

// Uploads run a few at a time: a step that read many screenshots should not wait on each in turn.
const PARALLEL_UPLOADS = 4
// How long one PUT may take: the file at 1 Mbit/s, plus time to connect and for the store to answer.
// Guesses. A storage host that never answers must not hold the request; its media goes inline instead.
const UPLOAD_SETUP_MS = 30_000
const UPLOAD_BYTES_PER_MS = 125
const uploadTimeout = (bytes: number) => UPLOAD_SETUP_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_MS)

// The control plane answered without a URL for a file, or the storage host did not take one. In the
// control plane's own shape, so the caller answers it as it would a refused request and the engine
// tries again. Nothing from the storage host is passed on.
const uploadFailed = () =>
  Response.json({ error: { message: "Arena media upload failed", type: "arena_media_upload_failed" } }, { status: 502 })

type UploadInput = {
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
}

type UploadResult = Response | "unsupported" | undefined

// Uploads under way, per upstream and digest. Both sides of a battle send the user's images at the
// same moment, and often read the same files: the second request waits for the first one's upload
// instead of sending the bytes again.
const inflight = new Map<string, Promise<void>>()

/** Settles when every promise has, or rejects with the signal's reason once it aborts. */
function waitFor(promises: Iterable<Promise<void>>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    void Promise.all(promises).then(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    })
  })
}

/**
 * Uploads the media the control plane may not have yet: one request for an upload URL per file, then
 * each file's bytes to its URL. Returns undefined when every upload succeeded, "unsupported" when
 * the control plane has no upload route, or the refusal, which the caller answers as it would the
 * request's own.
 */
export async function uploadMedia(input: UploadInput): Promise<UploadResult> {
  const wanted = [...input.media].filter((item) => !uploaded.has(key(input.upstream, item.digest)))
  if (wanted.length === 0) return undefined
  // Another request found the route missing or the store failing after this one chose references.
  if (unsupported.has(input.upstream)) return "unsupported"
  if (sendsInline(input.upstream)) return uploadFailed()
  const others = new Set<Promise<void>>()
  const pending: Media[] = []
  for (const item of wanted) {
    const running = inflight.get(key(input.upstream, item.digest))
    if (running) others.add(running)
    else pending.push(item)
  }
  if (pending.length > 0) {
    const done = Promise.withResolvers<void>()
    for (const item of pending) inflight.set(key(input.upstream, item.digest), done.promise)
    try {
      const refused = await storeMedia(input, pending)
      if (refused !== undefined) return refused
    } finally {
      for (const item of pending) {
        if (inflight.get(key(input.upstream, item.digest)) === done.promise) {
          inflight.delete(key(input.upstream, item.digest))
        }
      }
      done.resolve()
    }
  }
  if (others.size === 0) return undefined
  await waitFor(others, input.signal)
  // The request that had them failed, which paused the store, or was stopped: this one sends what
  // is still missing itself.
  const left = wanted.filter((item) => !uploaded.has(key(input.upstream, item.digest)))
  return left.length === 0 ? undefined : uploadMedia({ ...input, media: left })
}

async function storeMedia(input: UploadInput, pending: Media[]): Promise<UploadResult> {
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
  if (!response.ok) {
    // The control plane's own failure, its store's, or the account's upload limit. A refused
    // account or assignment is the request's to answer, and pauses nothing.
    if (response.status >= 500 || response.status === 429) pauseReferences(input.upstream)
    return response
  }
  const urls = readMediaUploadAnswer(await response.text())
  if (!urls || pending.some((item) => !urls.has(item.digest))) {
    pauseReferences(input.upstream)
    return uploadFailed()
  }
  const put = input.put ?? fetch
  const queue = [...pending]
  let failed = false
  const next = async (): Promise<void> => {
    const item = queue.shift()
    if (!item || failed) return
    const stored = await put(urls.get(item.digest)!, {
      method: "PUT",
      headers: { "Content-Type": item.mimeType },
      body: new Uint8Array(item.data),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(uploadTimeout(item.data.byteLength))]),
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
    if (!sendsInline(input.upstream)) confirmed.add(input.upstream)
    return next()
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, next))
  if (!failed) return undefined
  pauseReferences(input.upstream)
  return uploadFailed()
}
