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
// A MongoDB document holds at most 16 MiB; the rest is room for the fields around the data. A larger
// part is left out and reported missing on load.
const MAX_PART_BYTES = 15 * 1024 * 1024
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024

// A base64 data URL anywhere in a message: pasted screenshots, images a tool read, PDFs as `file_data`.
const DATA_URL = /^data:([^;,]+);base64,/
const MEDIA_REFERENCE = "arena-media:sha256:"

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

async function storeParts(db: ArenaDb, userId: string, split: ReturnType<typeof splitRequest>, createdAt: Date) {
  const candidates = [
    ...split.media.map(
      (item): PartDocument => ({
        _id: partID(userId, "media", item.sha256),
        userId,
        kind: "media",
        sha256: item.sha256,
        bytes: item.bytes,
        data: item.data,
        createdAt,
      }),
    ),
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

type CaptureInput = CaptureKey & {
  readonly model: string
  readonly endpoint: string
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
