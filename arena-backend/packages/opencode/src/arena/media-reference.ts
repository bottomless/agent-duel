import { createHash } from "crypto"
import {
  MEDIA_PATH,
  MEDIA_TYPE_HEADER,
  MEDIA_UPLOAD_PATH,
  mediaReference,
  mediaUploadRequest,
  readMediaUploadAnswer,
  sendsByReference,
} from "@agent-duel/arena-service/media"
import { readNetworkUnavailable } from "@agent-duel/arena-service/request-error"
import { MEDIA_UPLOAD_BYTES, REQUEST_BYTES_LIMIT } from "./engine-runtime/request-size"

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
// Upstreams that answered the upload route with 404, with when to ask again: a control plane older
// than the route, or one with no store. Until then their requests carry their media inline, as
// before, and are sized for that (`request-size.ts`), which is the one case that leaves images out
// for the body limit. So it ends: a deploy that lost its store for an hour must not leave every
// open desktop trimming until it restarts. A guess. Every other hosted request is sized for
// references from the first call on.
const unsupported = new Map<string, number>()
const UNSUPPORTED_MS = 30 * 60 * 1000
// Upstreams whose store failed an upload, or could not read back a file it had just taken, with
// when to try it again. Until then a request whose body fits carries its media inline without
// asking the store, so a storage host that stops answering holds such a request once, not at every
// step. A body that does not fit still asks: nothing else can carry it, and leaving images out to
// make it fit rewrites the prompt prefix. A guess: long enough to outlast a short outage, short
// enough that a chat goes back to references while it runs.
const paused = new Map<string, number>()
const STORE_PAUSE_MS = 5 * 60 * 1000
// When a paused store was last asked, per upstream. A body that cannot go inline is retried up to
// ten times, by both sides; each ask uploads again and counts against the account's upload limit,
// so a store that is down for an hour would use the day's limit up. A paused store is asked for one
// file, this far apart. A guess: a few asks inside the engine's retries.
const probed = new Map<string, number>()
const PROBE_MS = 15_000
// Upstreams whose storage host did not take a file that the control plane then took itself, with
// when to try the storage host again: a network that blocks it. Until then a file goes through the
// control plane first, so each upload does not wait out a PUT that fails. A guess: such a network
// stays that way, and a wrong guess costs only the detour.
const relayed = new Map<string, number>()
const RELAY_MS = 30 * 60 * 1000
// The largest file the control plane takes itself: one hosted request, its body the raw bytes.
const MEDIA_RELAY_BYTES = REQUEST_BYTES_LIMIT

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

/** Whether this upstream's control plane takes uploads: every one, unless it answered the route with 404 lately. */
export const referencesSupported = (upstream: string) => (unsupported.get(upstream) ?? 0) <= Date.now()

/**
 * Whether the daemon answered that this machine cannot reach the control plane. The session waits
 * for the network on that answer without spending a retry, and it says nothing about the store.
 */
async function networkDown(response: Response) {
  // The daemon answers it as JSON. Any other 503 is not read: its body may never end.
  if (response.status !== 503 || !response.headers.get("content-type")?.includes("json")) return false
  return readNetworkUnavailable(await response.clone().text())
}

/** Whether this upstream's store failed a few minutes ago: a body that fits goes inline meanwhile. */
export const storePaused = (upstream: string) => (paused.get(upstream) ?? 0) > Date.now()

/**
 * Stops asking this upstream's store for a while, because it failed. A request whose body fits sends
 * its media inline; one whose body does not fit still asks, and fails in a way the engine retries.
 */
export function pauseReferences(upstream: string) {
  paused.set(upstream, Date.now() + STORE_PAUSE_MS)
}

/** The control plane no longer has these; the next upload of each sends it again. */
export function forgetUploads(upstream: string, digests: ReadonlyArray<string>) {
  for (const digest of digests) uploaded.delete(key(upstream, digest))
}

// Uploads run a few at a time: a step that read many screenshots should not wait on each in turn.
const PARALLEL_UPLOADS = 4
// How long one upload may take: the file at 1 Mbit/s, plus time to connect and for the store to
// answer. Guesses. A storage host that never answers must not hold the request.
const UPLOAD_SETUP_MS = 30_000
const UPLOAD_BYTES_PER_MS = 125
const uploadTimeout = (bytes: number) => UPLOAD_SETUP_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_MS)

// The control plane answered without a URL for a file, or neither the storage host nor the control
// plane took one. In the control plane's own shape, so the caller answers it as it would a refused
// request and the engine tries again. Nothing from the storage host is passed on.
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
  /** Whether the request's body cannot go inline, so the store is asked even while it is paused. */
  readonly required?: () => boolean
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
 * each file's bytes to its URL. A file the storage host does not take goes through the control
 * plane instead. Returns undefined when every upload succeeded, "unsupported" when the control plane
 * has no upload route, or the refusal, which the caller answers as it would the request's own.
 */
export async function uploadMedia(input: UploadInput): Promise<UploadResult> {
  const wanted = [...input.media].filter((item) => !uploaded.has(key(input.upstream, item.digest)))
  if (wanted.length === 0) return undefined
  // Another request found the route missing or the store failing after this one chose references.
  if (!referencesSupported(input.upstream)) return "unsupported"
  if (storePaused(input.upstream) && !input.required?.()) return uploadFailed()
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
  // Only a body that cannot go inline asks a paused store.
  if (!storePaused(input.upstream)) return sendFiles(input, pending)
  if (Date.now() - (probed.get(input.upstream) ?? 0) < PROBE_MS) return uploadFailed()
  probed.set(input.upstream, Date.now())
  const [first, ...rest] = pending
  const refused = await sendFiles(input, [first!])
  if (refused !== undefined) {
    // An offline machine was not an ask: its next retry must reach the daemon and wait again.
    if (refused instanceof Response && (await networkDown(refused))) probed.delete(input.upstream)
    return refused
  }
  // The store took a file: it is back, for every request.
  paused.delete(input.upstream)
  return rest.length === 0 ? undefined : sendFiles(input, rest)
}

async function sendFiles(input: UploadInput, pending: Media[]): Promise<UploadResult> {
  const fitsRelay = (item: Media) => item.data.byteLength <= MEDIA_RELAY_BYTES
  // While the storage host does not take this machine's files, only those the control plane cannot
  // take ask for a URL. Read again for each file: the first one of a batch can be what finds out.
  const relaysFirst = () => (relayed.get(input.upstream) ?? 0) > Date.now()
  const direct = relaysFirst() ? pending.filter((item) => !fitsRelay(item)) : pending
  let urls: ReadonlyMap<string, string> = new Map()
  if (direct.length > 0) {
    const response = await input.execute(`${input.upstream}${MEDIA_UPLOAD_PATH}`, {
      method: "POST",
      headers: { ...input.routing, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        mediaUploadRequest(direct.map(({ digest, mimeType, data }) => ({ digest, mimeType, size: data.byteLength }))),
      ),
      signal: input.signal,
    })
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      unsupported.set(input.upstream, Date.now() + UNSUPPORTED_MS)
      return "unsupported"
    }
    if (response.status === 429) {
      // The account's upload limit. Its answer is not the request's to pass on: a session waits on
      // a 429 as a provider's rate limit, and this one lasts until the day ends. The step is
      // retried like a store failure.
      await response.body?.cancel().catch(() => undefined)
      pauseReferences(input.upstream)
      return uploadFailed()
    }
    if (!response.ok) {
      // The control plane's own failure or its store's. A refused account or assignment, or an
      // offline machine, is the request's to answer, and pauses nothing.
      if (response.status >= 500 && !(await networkDown(response))) pauseReferences(input.upstream)
      return response
    }
    const answered = readMediaUploadAnswer(await response.text())
    if (!answered || direct.some((item) => !answered.has(item.digest))) {
      pauseReferences(input.upstream)
      return uploadFailed()
    }
    urls = answered
  }
  const put = input.put ?? fetch
  const queue = [...pending]
  let failure: UploadResult
  const next = async (): Promise<void> => {
    const item = queue.shift()
    if (!item || failure !== undefined) return
    const url = relaysFirst() && fitsRelay(item) ? undefined : urls.get(item.digest)
    if (url === undefined || !(await putFile(put, url, item, input.signal))) {
      const relay = fitsRelay(item) ? await relayFile(input, item) : "failed"
      if (relay !== "stored") {
        if (relay instanceof Response && failure !== undefined) await relay.body?.cancel().catch(() => undefined)
        failure ??= relay === "failed" ? uploadFailed() : relay
        if (relay === "failed") {
          pauseReferences(input.upstream)
          // The next upload asks for a URL again: only that route says a control plane has no store.
          relayed.delete(input.upstream)
        }
        return
      }
      // The storage host did not take it and the control plane did.
      if (url !== undefined) relayed.set(input.upstream, Date.now() + RELAY_MS)
    }
    uploaded.add(key(input.upstream, item.digest))
    return next()
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, next))
  return failure
}

/** Sends a file to its upload URL. False when the storage host did not take it. */
async function putFile(put: NonNullable<UploadInput["put"]>, url: string, item: Media, signal: AbortSignal) {
  const stored = await put(url, {
    method: "PUT",
    headers: { "Content-Type": item.mimeType },
    body: new Uint8Array(item.data),
    signal: AbortSignal.any([signal, AbortSignal.timeout(uploadTimeout(item.data.byteLength))]),
  }).catch((error: unknown) => {
    if (signal.aborted) throw error
    return undefined
  })
  await stored?.body?.cancel().catch(() => undefined)
  return stored?.ok === true
}

/**
 * Sends a file to the control plane, which writes it to the same store: the route desktops released
 * before the upload route use. For a machine that reaches the control plane and not the storage
 * host. A refusal that is the request's to answer, or an offline machine's, comes back as it is.
 */
async function relayFile(input: UploadInput, item: Media): Promise<"stored" | "failed" | Response> {
  const response = await input
    .execute(`${input.upstream}${MEDIA_PATH}`, {
      method: "POST",
      headers: { ...input.routing, "Content-Type": "application/octet-stream", [MEDIA_TYPE_HEADER]: item.mimeType },
      body: new Uint8Array(item.data),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(uploadTimeout(item.data.byteLength))]),
    })
    .catch((error: unknown) => {
      if (input.signal.aborted) throw error
      return undefined
    })
  if (!response) return "failed"
  if (await networkDown(response)) return response
  // The store's failure, a route that is not there, or the account's upload limit, which is never
  // the request's to pass on.
  if (response.ok || response.status === 404 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined)
    return response.ok ? "stored" : "failed"
  }
  return response
}
