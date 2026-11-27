import { createHash } from "crypto"
import { isDuplicateKeyError, type ArenaCollection, type ArenaDb } from "./collection"
import { mediaPathname, type MediaStore, type StoredMedia } from "./media-store"

// The hosted service keeps each contestant call, battle or single-agent, as OpenRouter saw it: the
// body after routing, restored reasoning and the output cap, and the raw response before the scrub.
// The desktop cannot keep either: real tool-call ids, reasoning formats and the slug name the model,
// and a BYOK store sits on the voter's machine. A chat resends its whole history on every call, so a
// body is split into components and media keyed by content under the account: both sides and every
// later call store only what is new, and a deletion request still removes one account's parts alone.

const CAPTURES = "arenaGenerationCaptures"
const PARTS = "arenaGenerationParts"
// A MongoDB document holds at most 16 MiB; the rest is room for the fields around the data. A larger
// part is left out and reported missing on load.
const MAX_PART_BYTES = 15 * 1024 * 1024
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024

// A base64 data URL anywhere in a message: pasted screenshots, images a tool read, PDFs as `file_data`.
const DATA_URL = /^data:([^;,]+);base64,/
/** `arena-media:sha256:<digest>:<mime>` names a stored media part in place of its data URL. */
export const MEDIA_REFERENCE = "arena-media:sha256:"
const MEDIA_REFERENCE_PATTERN = /^arena-media:sha256:([0-9a-f]{64}):([\w.+-]+\/[\w.+-]+)$/

export type CaptureComponentKind = "params" | "system" | "tools" | "message"

export type CaptureComponent = {
  readonly kind: CaptureComponentKind
  readonly role?: string
  readonly sha256: string
  readonly bytes: number
}

export type CaptureMedia = {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
}

export type CapturedRequest = {
  /** SHA-256 of the body sent, so a verified rebuild is byte-identical. */
  readonly bodyHash: string
  readonly bytes: number
  /** The body's top-level keys in wire order. */
  readonly keys: ReadonlyArray<string>
  readonly components: ReadonlyArray<CaptureComponent>
  readonly media: ReadonlyArray<CaptureMedia>
}

export type CaptureState = "complete" | "failed" | "cancelled"

export type CapturedResponse = {
  readonly state: CaptureState
  /** The upstream status; none when the request never got an answer. */
  readonly status?: number
  /** The upstream bytes as text, or none when they exceeded `MAX_RESPONSE_BYTES`. */
  readonly body?: string
  readonly bytes: number
  readonly truncated?: true
  readonly completedAt: Date
}

export type CaptureKey = {
  readonly userId: string
  /** The battle's turn ID, or for a single-agent turn its singleAgentRatings record's _id. */
  readonly scopeID: string
  readonly assignmentID: string
  readonly generationID: string
}

type CaptureDocument = CaptureKey & {
  readonly _id: string
  readonly model: string
  readonly endpoint: string
  readonly createdAt: Date
  readonly request: CapturedRequest
  readonly response?: CapturedResponse
  /** A refused attempt archived separately before this logical generation was retried. */
  readonly retriedByGenerationID?: string
}

type PartDocument = {
  readonly _id: string
  readonly userId: string
  readonly kind: "component" | "media"
  readonly sha256: string
  readonly bytes: number
  readonly text?: string
  readonly data?: Uint8Array
  readonly createdAt: Date
}

type SplitComponent = CaptureComponent & { readonly text: string }
type SplitMedia = CaptureMedia & { readonly data: Buffer }

function captures(db: ArenaDb): ArenaCollection<CaptureDocument> {
  return db.collection<CaptureDocument>(CAPTURES)
}

function parts(db: ArenaDb): ArenaCollection<PartDocument> {
  return db.collection<PartDocument>(PARTS)
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function captureID(userId: string, generationID: string) {
  return sha256(`${userId.length}:${userId}|${generationID}`)
}

function partID(userId: string, kind: PartDocument["kind"], digest: string) {
  return sha256(`${userId.length}:${userId}|${kind}|${digest}`)
}

function binary(data: unknown) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  // The MongoDB driver returns its own Binary wrapper around the bytes.
  const wrapped = data as { readonly buffer?: unknown } | null
  if (wrapped?.buffer instanceof Uint8Array) return Buffer.from(wrapped.buffer)
  return undefined
}

function walkStrings(value: unknown, replace: (text: string) => string | undefined): unknown {
  if (typeof value === "string") return replace(value) ?? value
  if (Array.isArray(value)) return value.map((item) => walkStrings(item, replace))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walkStrings(item, replace)]))
}

function externalizeMedia(value: unknown, media: Map<string, SplitMedia>) {
  return walkStrings(value, (text) => {
    const match = DATA_URL.exec(text)
    const mimeType = match?.[1]
    if (!match || !mimeType) return undefined
    const payload = text.slice(match[0].length)
    const data = Buffer.from(payload, "base64")
    // Keep a payload Node would not re-encode to the same text inline, so the rebuild stays exact.
    if (data.toString("base64") !== payload) return undefined
    const id = sha256(data)
    if (!media.has(id)) media.set(id, { sha256: id, mimeType, bytes: data.byteLength, data })
    return `${MEDIA_REFERENCE}${id}:${mimeType}`
  })
}

function inlineMedia(value: unknown, media: ReadonlyMap<string, Buffer>) {
  return walkStrings(value, (text) => {
    if (!text.startsWith(MEDIA_REFERENCE)) return undefined
    const separator = text.indexOf(":", MEDIA_REFERENCE.length)
    if (separator < 0) return undefined
    const data = media.get(text.slice(MEDIA_REFERENCE.length, separator))
    return data ? `data:${text.slice(separator + 1)};base64,${data.toString("base64")}` : undefined
  })
}

/** The digests of the media references in a request body, with how often the body names each. */
export function mediaReferences(value: unknown) {
  const counts = new Map<string, number>()
  walkStrings(value, (text) => {
    const digest = MEDIA_REFERENCE_PATTERN.exec(text)?.[1]
    if (digest) counts.set(digest, (counts.get(digest) ?? 0) + 1)
    return undefined
  })
  return counts
}

function componentOf(kind: CaptureComponentKind, value: unknown, role?: string): SplitComponent {
  const text = JSON.stringify(value)
  return { kind, ...(role ? { role } : {}), sha256: sha256(text), bytes: Buffer.byteLength(text), text }
}

/** Splits a chat completions body; any other body is kept whole as its parameters. */
export function splitRequest(body: Readonly<Record<string, unknown>>) {
  const params: Record<string, unknown> = {}
  const components: SplitComponent[] = []
  const media = new Map<string, SplitMedia>()
  const messages = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages : undefined
  for (const [key, value] of Object.entries(body)) {
    if ((key === "system" || key === "tools") && value !== undefined) continue
    if (key === "messages" && messages) continue
    params[key] = value
  }
  components.push(componentOf("params", params))
  if (body.system !== undefined) components.push(componentOf("system", body.system))
  if (body.tools !== undefined) components.push(componentOf("tools", body.tools))
  for (const message of messages ?? []) {
    const role = (message as { role?: unknown } | null)?.role
    components.push(
      componentOf("message", externalizeMedia(message, media), typeof role === "string" ? role : undefined),
    )
  }
  return { components, media: [...media.values()] }
}

const mediaPart = (userId: string, item: SplitMedia, createdAt: Date): PartDocument => ({
  _id: partID(userId, "media", item.sha256),
  userId,
  kind: "media",
  sha256: item.sha256,
  bytes: item.bytes,
  data: item.data,
  createdAt,
})

async function insertNewParts(db: ArenaDb, userId: string, candidates: ReadonlyArray<PartDocument>) {
  const unique = [...new Map(candidates.map((part) => [part._id, part])).values()]
  const stored = await parts(db)
    .find({ _id: { $in: unique.map((part) => part._id) }, userId }, { projection: { _id: 1 } })
    .toArray()
  const known = new Set(stored.map((part) => part._id))
  for (const part of unique) {
    if (known.has(part._id)) continue
    // The other side of the battle sends the same history at the same moment.
    await parts(db)
      .insertOne(part)
      .catch((error: unknown) => {
        if (!isDuplicateKeyError(error)) throw error
      })
  }
}

// Media the engine sends by reference (`media.ts`) is not a capture part: it sits in the control
// plane's object store (`media-store.ts`), which deletes it 3 to 4 days after the upload. A capture
// stores its own copy of what the call sent. An expired file is uploaded again on the next call that
// names it, and its reference, and so the prompt, stays the same.

// A chat sends the same images on every call, so a warm function keeps the last ones it loaded
// instead of reading them from the store again each time. Keyed by pathname, so by account too, and
// dropped when the file expires.
const MEDIA_CACHE_BYTES = 64 * 1024 * 1024
const mediaCache = new Map<string, { readonly data: Buffer; readonly expiresAt: Date }>()
let mediaCacheBytes = 0

function cachedMedia(pathname: string, now: Date) {
  const entry = mediaCache.get(pathname)
  if (!entry) return undefined
  mediaCache.delete(pathname)
  if (entry.expiresAt.getTime() <= now.getTime()) {
    mediaCacheBytes -= entry.data.byteLength
    return undefined
  }
  mediaCache.set(pathname, entry)
  return entry.data
}

function cacheMedia(pathname: string, data: Buffer, expiresAt: Date) {
  if (mediaCache.has(pathname) || data.byteLength > MEDIA_CACHE_BYTES / 4) return
  mediaCache.set(pathname, { data, expiresAt })
  mediaCacheBytes += data.byteLength
  for (const [oldest, value] of mediaCache) {
    if (mediaCacheBytes <= MEDIA_CACHE_BYTES) break
    mediaCache.delete(oldest)
    mediaCacheBytes -= value.data.byteLength
  }
}

// The engine keeps a request under 90 images and 16 MB of media (`request-size.ts` in opencode), and
// Anthropic refuses more than 100 images or 32 MB. A body that names more is refused before its media
// loads: each reference expands to its whole file, so a few kilobytes could otherwise build gigabytes.
const MAX_MEDIA_REFERENCES = 200
const MAX_RESOLVED_MEDIA_BYTES = 32_000_000
// Store reads run a few at a time, so a body that names many files does not open each at once on a
// cold function. A guess.
const PARALLEL_READS = 8
/**
 * The longest a call waits on the store for its media, bodies included. A guess: a request's 32 MB
 * reads in seconds from the store's region, and a store that stops answering must not hold the call
 * until its function's time runs out.
 */
export const MEDIA_LOAD_MS = 30_000

/** The promise's value, or the signal's reason once it aborts; a value that comes later goes to `late`. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => void) {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop)
        if (signal.aborted) late?.(value)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop)
        reject(error)
      },
    )
  })
}

const encodedBytes = (bytes: number) => Math.ceil(bytes / 3) * 4

/** A stored file's bytes, or undefined when they are not the file the digest names. */
async function readMedia(file: StoredMedia, digest: string, signal: AbortSignal | undefined) {
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = file.body.getReader()
  for (;;) {
    const { done, value } = await abortable(reader.read(), signal).catch(async (error: unknown) => {
      await reader.cancel().catch(() => undefined)
      throw error
    })
    if (done) break
    bytes += value.byteLength
    // The size was what counted against the limit, so a longer body stops here.
    if (bytes > file.size) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const data = Buffer.concat(chunks)
  return sha256(data) === digest ? data : undefined
}

export type ResolvedMedia = {
  readonly body: unknown
  /** Digests the account has no media for. */
  readonly missing: string[]
  /** The body names more media than any provider takes. */
  readonly tooLarge: boolean
}

/** Where a call's media came from, for the log line the cache hit rate is read from. */
type MediaReads = { cached: number; stored: number; storeMs: number }

type LoadedMedia =
  | { readonly media: ReadonlyMap<string, Buffer> }
  | { readonly missing: string[] }
  | { readonly tooLarge: true }

async function loadMedia(
  store: MediaStore | undefined,
  userId: string,
  counts: ReadonlyMap<string, number>,
  now: Date,
  reads: MediaReads,
  signal: AbortSignal | undefined,
): Promise<LoadedMedia> {
  let named = 0
  for (const count of counts.values()) named += count
  if (named > MAX_MEDIA_REFERENCES) return { tooLarge: true }
  const media = new Map<string, Buffer>()
  const unknown: string[] = []
  // What the references expand to so far. Each file counts before its body is read, so a body that
  // names large files stops loading at the limit.
  let resolvedBytes = 0
  for (const [digest, count] of counts) {
    const data = cachedMedia(mediaPathname(userId, digest), now)
    if (!data) {
      unknown.push(digest)
      continue
    }
    media.set(digest, data)
    resolvedBytes += encodedBytes(data.byteLength) * count
  }
  reads.cached = media.size
  if (resolvedBytes > MAX_RESOLVED_MEDIA_BYTES) return { tooLarge: true }
  if (unknown.length === 0) return { media }
  if (!store) return { missing: unknown }
  const missing: string[] = []
  let tooLarge = false
  let failure: { readonly reason: unknown } | undefined
  // Each reader finishes or cancels the body it opened, so a read that fails leaves none half read.
  const next = async (): Promise<void> => {
    const digest = unknown.shift()
    if (digest === undefined || tooLarge || failure) return
    if (signal?.aborted) {
      failure = { reason: signal.reason }
      return
    }
    const pathname = mediaPathname(userId, digest)
    // A store that ignores the signal still lets the call go; a file it opens too late is let go too.
    const file = await abortable(store.read(pathname, { signal }), signal, (late) => {
      void late?.body.cancel().catch(() => undefined)
    }).catch((reason: unknown) => {
      failure ??= { reason }
      return null
    })
    if (file === null) return
    // A file past its time is missing, even while the store has not deleted it yet. The rest are
    // still read, so the engine uploads every missing file in one go and the call after it finds the
    // others warm.
    if (!file || file.expiresAt.getTime() <= now.getTime()) {
      missing.push(digest)
      await file?.body.cancel().catch(() => undefined)
      return next()
    }
    resolvedBytes += encodedBytes(file.size) * (counts.get(digest) ?? 0)
    if (resolvedBytes > MAX_RESOLVED_MEDIA_BYTES) tooLarge = true
    if (tooLarge || failure) {
      await file.body.cancel().catch(() => undefined)
      return
    }
    const data = await readMedia(file, digest, signal).catch((reason: unknown) => {
      failure ??= { reason }
      return null
    })
    if (data === null) return
    // Bytes that are not the file the digest names are missing, and never kept: the engine uploads
    // the file again over them.
    if (!data) missing.push(digest)
    else {
      media.set(digest, data)
      cacheMedia(pathname, data, file.expiresAt)
      reads.stored++
    }
    return next()
  }
  const startedAt = Date.now()
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, unknown.length) }, next))
  } finally {
    reads.storeMs = Date.now() - startedAt
  }
  if (failure) throw failure.reason
  if (tooLarge) return { tooLarge: true }
  return missing.length > 0 ? { missing } : { media }
}

/**
 * Puts the account's stored media back in place of its references. An expired file is missing, and so
 * is every file when the service has no store. Throws when the store fails, or when `signal` aborts
 * before the media is read.
 */
export async function resolveMedia(
  store: MediaStore | undefined,
  userId: string,
  body: unknown,
  now: Date,
  signal?: AbortSignal,
): Promise<ResolvedMedia> {
  const counts = mediaReferences(body)
  if (counts.size === 0) return { body, missing: [], tooLarge: false }
  const reads: MediaReads = { cached: 0, stored: 0, storeMs: 0 }
  const loaded = await loadMedia(store, userId, counts, now, reads, signal)
  const missing = "missing" in loaded ? loaded.missing : []
  // Counts and a duration only: no content, digest or account.
  console.info("[arena-service] Arena media", JSON.stringify({ files: counts.size, ...reads, missing: missing.length }))
  if (!("media" in loaded)) return { body, missing, tooLarge: "tooLarge" in loaded }
  const { media } = loaded
  const encoded = new Map<string, string>()
  const resolved = walkStrings(body, (text) => {
    const match = MEDIA_REFERENCE_PATTERN.exec(text)
    const data = match && media.get(match[1]!)
    if (!match || !data) return undefined
    const base64 = encoded.get(match[1]!) ?? data.toString("base64")
    encoded.set(match[1]!, base64)
    return `data:${match[2]};base64,${base64}`
  })
  return { body: resolved, missing, tooLarge: false }
}

async function storeParts(db: ArenaDb, userId: string, split: ReturnType<typeof splitRequest>, createdAt: Date) {
  const candidates = [
    ...split.media.map((item) => mediaPart(userId, item, createdAt)),
    ...split.components.map(
      (component): PartDocument => ({
        _id: partID(userId, "component", component.sha256),
        userId,
        kind: "component",
        sha256: component.sha256,
        bytes: component.bytes,
        text: component.text,
        createdAt,
      }),
    ),
  ].filter((part) => part.bytes <= MAX_PART_BYTES)
  await insertNewParts(db, userId, candidates)
}

type CaptureInput = CaptureKey & {
  readonly model: string
  readonly endpoint: string
  readonly retriedByGenerationID?: string
}

export type GenerationCapture = ReturnType<typeof generationCapture>

/**
 * Records one contestant call. `request` takes the body as sent and stores it after the request has
 * left; `record` takes the upstream response text; `finish` stores it. Writes run in order and only
 * log a failure, so a capture never fails the call. The response waits for `finish`, as it does for
 * metrics: a hosted function may stop once its response ends.
 */
export function generationCapture(db: ArenaDb, input: CaptureInput, now: () => Date) {
  const id = captureID(input.userId, input.generationID)
  const chunks: string[] = []
  let bytes = 0
  let truncated = false
  let settled = false
  let writes = Promise.resolve()
  const enqueue = (work: () => Promise<unknown>) => {
    writes = writes.then(work).then(
      () => undefined,
      () => console.error("[arena-service] Arena generation capture could not be stored"),
    )
    return writes
  }
  return {
    request(body: string) {
      void enqueue(async () => {
        // Splitting a long history takes a few milliseconds; let the request leave first.
        await new Promise((resolve) => setImmediate(resolve))
        const parsed = JSON.parse(body) as Record<string, unknown>
        const split = splitRequest(parsed)
        const createdAt = now()
        await storeParts(db, input.userId, split, createdAt)
        await captures(db).replaceOne(
          { _id: id },
          {
            _id: id,
            userId: input.userId,
            scopeID: input.scopeID,
            assignmentID: input.assignmentID,
            generationID: input.generationID,
            ...(input.retriedByGenerationID ? { retriedByGenerationID: input.retriedByGenerationID } : {}),
            model: input.model,
            endpoint: input.endpoint,
            createdAt,
            request: {
              bodyHash: sha256(body),
              bytes: Buffer.byteLength(body),
              keys: Object.keys(parsed),
              components: split.components.map(({ kind, role, sha256: digest, bytes: size }) => ({
                kind,
                ...(role ? { role } : {}),
                sha256: digest,
                bytes: size,
              })),
              media: split.media.map(({ sha256: digest, mimeType, bytes: size }) => ({
                sha256: digest,
                mimeType,
                bytes: size,
              })),
            },
          },
          { upsert: true },
        )
      })
    },
    record(text: string) {
      if (settled || !text) return
      bytes += Buffer.byteLength(text)
      if (truncated) return
      if (bytes <= MAX_RESPONSE_BYTES) {
        chunks.push(text)
        return
      }
      truncated = true
      chunks.length = 0
    },
    finish(state: CaptureState, status?: number) {
      if (settled) return writes
      settled = true
      const response: CapturedResponse = {
        state,
        ...(status === undefined ? {} : { status }),
        ...(truncated ? { truncated: true as const } : { body: chunks.join("") }),
        bytes,
        completedAt: now(),
      }
      chunks.length = 0
      return enqueue(() => captures(db).updateOne({ _id: id, userId: input.userId }, { $set: { response } }))
    },
  }
}

export type LoadedCapture = {
  readonly capture: CaptureDocument
  readonly body: Record<string, unknown>
  /** Digests of components and media that are not stored. */
  readonly missing: ReadonlyArray<string>
  /** Whether the rebuilt body is byte-identical to the one sent. */
  readonly verified: boolean
}

/** Rebuilds the request one account's contestant call sent, with its recorded response. */
export async function loadGenerationCapture(
  db: ArenaDb,
  userId: string,
  generationID: string,
): Promise<LoadedCapture | undefined> {
  const capture = await captures(db).findOne({ _id: captureID(userId, generationID), userId })
  if (!capture) return undefined
  const { request } = capture
  const ids = [
    ...request.media.map((item) => partID(userId, "media", item.sha256)),
    ...request.components.map((component) => partID(userId, "component", component.sha256)),
  ]
  const stored = new Map(
    (
      await parts(db)
        .find({ _id: { $in: [...new Set(ids)] }, userId })
        .toArray()
    ).map((part) => [part._id, part]),
  )
  const missing: string[] = []
  const media = new Map<string, Buffer>()
  for (const item of request.media) {
    const data = binary(stored.get(partID(userId, "media", item.sha256))?.data)
    if (!data || sha256(data) !== item.sha256) {
      missing.push(item.sha256)
      continue
    }
    media.set(item.sha256, data)
  }
  let params: Record<string, unknown> = {}
  const sections: Record<string, unknown> = {}
  const messages: unknown[] = []
  for (const component of request.components) {
    const text = stored.get(partID(userId, "component", component.sha256))?.text
    if (text === undefined || sha256(text) !== component.sha256) {
      missing.push(component.sha256)
      continue
    }
    const value = JSON.parse(text) as unknown
    if (component.kind === "message") messages.push(inlineMedia(value, media))
    else if (component.kind === "params") params = value as Record<string, unknown>
    else sections[component.kind] = value
  }
  const hasMessages = request.components.some((component) => component.kind === "message")
  const body: Record<string, unknown> = {}
  for (const key of request.keys) {
    if ((key === "system" || key === "tools") && key in sections) body[key] = sections[key]
    else if (key === "messages" && hasMessages) body.messages = messages
    else if (key in params) body[key] = params[key]
  }
  const verified = missing.length === 0 && sha256(JSON.stringify(body)) === request.bodyHash
  return { capture, body, missing, verified }
}
