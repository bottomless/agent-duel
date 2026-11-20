import { createHash } from "crypto"
import { isDuplicateKeyError, type ArenaCollection, type ArenaDb } from "./collection"

// A hosted battle keeps each contestant call as OpenRouter saw it: the body after routing, restored
// reasoning and the output cap, and the raw response before the scrub. The desktop cannot keep
// either: real tool-call ids, reasoning formats and the slug name the model, and a BYOK store sits on
// the voter's machine. A chat resends its whole history on every call, so a body is split into
// components and media keyed by content under the account: both sides and every later call store
// only what is new, and a deletion request still removes one account's parts alone.

const CAPTURES = "arenaGenerationCaptures"
const PARTS = "arenaGenerationParts"
// Media the engine uploads to send by reference (`media.ts`). Kept apart from the capture parts so it
// can expire: a single-agent chat is never captured, and a battle's capture stores its own copy of
// what the call sent. A TTL index on `expiresAt` deletes old uploads; the control plane creates it by
// migration. An expired file is uploaded again on the next call that names it, and its reference,
// and so the prompt, stays the same.
const UPLOADS = "arenaMediaUploads"
const UPLOAD_TTL_MS = 72 * 60 * 60 * 1000
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

type UploadDocument = {
  readonly _id: string
  readonly userId: string
  readonly sha256: string
  readonly bytes: number
  readonly data?: Uint8Array
  readonly createdAt: Date
  readonly expiresAt: Date
}

type SplitComponent = CaptureComponent & { readonly text: string }
type SplitMedia = CaptureMedia & { readonly data: Buffer }

function captures(db: ArenaDb): ArenaCollection<CaptureDocument> {
  return db.collection<CaptureDocument>(CAPTURES)
}

function parts(db: ArenaDb): ArenaCollection<PartDocument> {
  return db.collection<PartDocument>(PARTS)
}

function uploads(db: ArenaDb): ArenaCollection<UploadDocument> {
  return db.collection<UploadDocument>(UPLOADS)
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

/** Keeps one media file the engine sends by reference until `UPLOAD_TTL_MS` passes, and returns its digest. */
export async function storeMedia(db: ArenaDb, userId: string, data: Buffer, createdAt: Date) {
  const digest = sha256(data)
  if (data.byteLength > MAX_PART_BYTES) throw new Error("Arena media is too large to store")
  const id = partID(userId, "media", digest)
  // Both sides of a battle upload the same file at the same moment; the second finds the first.
  const stored = await uploads(db).findOne({ _id: id, userId }, { projection: { _id: 1, expiresAt: 1 } })
  if (stored && stored.expiresAt.getTime() > createdAt.getTime()) return digest
  // An expired upload the TTL index has not deleted yet starts its time again.
  await uploads(db)
    .replaceOne(
      { _id: id },
      {
        _id: id,
        userId,
        sha256: digest,
        bytes: data.byteLength,
        data,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + UPLOAD_TTL_MS),
      },
      { upsert: true },
    )
    .catch((error: unknown) => {
      if (!isDuplicateKeyError(error)) throw error
    })
  return digest
}

// A chat sends the same images on every call, so a warm function keeps the last ones it loaded
// instead of reading them from the store again each time. Keyed by part id, so by account too, and
// dropped when the upload expires.
const MEDIA_CACHE_BYTES = 64 * 1024 * 1024
const mediaCache = new Map<string, { readonly data: Buffer; readonly expiresAt: Date }>()
let mediaCacheBytes = 0

function cachedMedia(id: string, now: Date) {
  const entry = mediaCache.get(id)
  if (!entry) return undefined
  mediaCache.delete(id)
  if (entry.expiresAt.getTime() <= now.getTime()) {
    mediaCacheBytes -= entry.data.byteLength
    return undefined
  }
  mediaCache.set(id, entry)
  return entry.data
}

function cacheMedia(id: string, data: Buffer, expiresAt: Date) {
  if (mediaCache.has(id) || data.byteLength > MEDIA_CACHE_BYTES / 4) return
  mediaCache.set(id, { data, expiresAt })
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

const encodedBytes = (bytes: number) => Math.ceil(bytes / 3) * 4

export type ResolvedMedia = {
  readonly body: unknown
  /** Digests the account has no media for. */
  readonly missing: string[]
  /** The body names more media than any provider takes. */
  readonly tooLarge: boolean
}

/** Puts the account's uploaded media back in place of its references. An expired upload is missing. */
export async function resolveMedia(db: ArenaDb, userId: string, body: unknown, now: Date): Promise<ResolvedMedia> {
  const counts = mediaReferences(body)
  if (counts.size === 0) return { body, missing: [], tooLarge: false }
  let named = 0
  for (const count of counts.values()) named += count
  if (named > MAX_MEDIA_REFERENCES) return { body, missing: [], tooLarge: true }
  const media = new Map<string, Buffer>()
  const unknown: string[] = []
  for (const digest of counts.keys()) {
    const data = cachedMedia(partID(userId, "media", digest), now)
    if (data) media.set(digest, data)
    else unknown.push(digest)
  }
  // Sizes first, so a body that names large files never loads more than the limit.
  const sizes =
    unknown.length === 0
      ? []
      : await uploads(db)
          .find(
            {
              _id: { $in: unknown.map((digest) => partID(userId, "media", digest)) },
              userId,
              expiresAt: { $gt: now },
            },
            { projection: { _id: 1, sha256: 1, bytes: 1, expiresAt: 1 } },
          )
          .toArray()
  const found = new Set(sizes.map((part) => part.sha256))
  const absent = unknown.filter((digest) => !found.has(digest))
  if (absent.length > 0) return { body, missing: absent, tooLarge: false }
  let resolvedBytes = 0
  for (const [digest, data] of media) resolvedBytes += encodedBytes(data.byteLength) * (counts.get(digest) ?? 0)
  for (const part of sizes) resolvedBytes += encodedBytes(part.bytes) * (counts.get(part.sha256) ?? 0)
  if (resolvedBytes > MAX_RESOLVED_MEDIA_BYTES) return { body, missing: [], tooLarge: true }
  const stored =
    sizes.length === 0
      ? []
      : await uploads(db)
          .find({ _id: { $in: sizes.map((part) => part._id) }, userId })
          .toArray()
  for (const part of stored) {
    const data = binary(part.data)
    if (!data || sha256(data) !== part.sha256) continue
    media.set(part.sha256, data)
    cacheMedia(part._id, data, part.expiresAt)
  }
  const missing = [...counts.keys()].filter((digest) => !media.has(digest))
  if (missing.length > 0) return { body, missing, tooLarge: false }
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
