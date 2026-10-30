import { createHash } from "crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import type { Store } from "./mongo"
import type { ArtifactDocument } from "./records"

export type RequestComponentKind = "params" | "system" | "tools" | "message"

export type RequestComponent = {
  readonly kind: RequestComponentKind
  readonly role?: string
  readonly sha256: string
  readonly bytes: number
}

export type RequestMedia = {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
}

export type RequestManifest = {
  readonly version: 2
  readonly generationID: string
  /** SHA-256 of the stored body's JSON text, so a verified rebuild is byte-identical. */
  readonly bodyHash: string
  /** The body's top-level keys in wire order. */
  readonly keys: ReadonlyArray<string>
  readonly components: ReadonlyArray<RequestComponent>
  readonly media: ReadonlyArray<RequestMedia>
}

type SplitComponent = RequestComponent & { readonly text: string }
type SplitMedia = RequestMedia & { readonly data: Buffer }

export type StoreRequestInput = {
  readonly runID: string
  readonly generationID: string
  readonly body: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly known?: Set<string>
}

export type LoadedRequest = {
  readonly manifest: RequestManifest
  readonly body: Record<string, unknown>
  readonly missing: ReadonlyArray<string>
  readonly verified: boolean
}

// A base64 data URL anywhere in a message: pasted screenshots, images a tool read, PDFs as `file_data`.
const DATA_URL = /^data:([^;,]+);base64,/
const MEDIA_REFERENCE = "arena-media:sha256:"

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function bytes(data: unknown) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  const binary = data as { readonly buffer?: unknown } | null
  if (binary?.buffer instanceof Uint8Array) return Buffer.from(binary.buffer)
  throw new Error("Arena request artifact has an unsupported binary payload")
}

function decodeText(artifact: ArtifactDocument) {
  const data = bytes(artifact.data)
  return (artifact.compression === "gzip" ? gunzipSync(data) : data).toString("utf8")
}

// Components and media are named by content alone: both sides and every later turn of a chat resend
// the same system prompt, tools, history, and screenshots, and each is kept once.
export function componentArtifactID(sha256Digest: string) {
  return `component|${sha256Digest}`
}

export function mediaArtifactID(sha256Digest: string) {
  return `media|${sha256Digest}`
}

export function manifestArtifactID(generationID: string) {
  return `${generationID}|manifest`
}

function mediaReference(id: string, mimeType: string) {
  return `${MEDIA_REFERENCE}${id}:${mimeType}`
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
    const key = `${id}:${mimeType}`
    if (!media.has(key)) media.set(key, { sha256: id, mimeType, bytes: data.byteLength, data })
    return mediaReference(id, mimeType)
  })
}

function inlineMedia(value: unknown, media: ReadonlyMap<string, Buffer>) {
  return walkStrings(value, (text) => {
    if (!text.startsWith(MEDIA_REFERENCE)) return undefined
    const separator = text.indexOf(":", MEDIA_REFERENCE.length)
    if (separator < 0) return undefined
    const id = text.slice(MEDIA_REFERENCE.length, separator)
    const data = media.get(id)
    return data ? `data:${text.slice(separator + 1)};base64,${data.toString("base64")}` : undefined
  })
}

function componentOf(kind: RequestComponentKind, value: unknown, role?: string): SplitComponent {
  const text = JSON.stringify(value)
  return {
    kind,
    ...(role ? { role } : {}),
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    text,
  }
}

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

export async function storeRequest(store: Store, input: StoreRequestInput): Promise<RequestManifest> {
  const split = splitRequest(input.body)
  const write = async (
    artifactID: string,
    artifact: Pick<ArtifactDocument, "mimeType" | "encoding" | "compression">,
    data: () => Uint8Array,
  ) => {
    if (input.known?.has(artifactID)) return
    await store.storeArtifact({
      _id: artifactID,
      runID: input.runID,
      kind: "generation_component",
      ...artifact,
      data: data(),
      createdAt: input.createdAt,
    })
    input.known?.add(artifactID)
  }
  for (const item of split.media) {
    await write(
      mediaArtifactID(item.sha256),
      { mimeType: item.mimeType, encoding: "binary", compression: "none" },
      () => item.data,
    )
  }
  for (const component of split.components) {
    await write(
      componentArtifactID(component.sha256),
      { mimeType: "application/json", encoding: "json", compression: "gzip" },
      () => gzipSync(Buffer.from(component.text), { level: 6 }),
    )
  }
  const seen = new Set<string>()
  const manifest: RequestManifest = {
    version: 2,
    generationID: input.generationID,
    bodyHash: sha256(JSON.stringify(input.body)),
    keys: Object.keys(input.body),
    components: split.components.map(({ kind, role, sha256: digest, bytes: size }) => ({
      kind,
      ...(role ? { role } : {}),
      sha256: digest,
      bytes: size,
    })),
    media: split.media.flatMap(({ sha256: digest, mimeType, bytes: size }) => {
      if (seen.has(digest)) return []
      seen.add(digest)
      return [{ sha256: digest, mimeType, bytes: size }]
    }),
  }
  await store.storeArtifact({
    _id: manifestArtifactID(input.generationID),
    runID: input.runID,
    kind: "generation_manifest",
    mimeType: "application/json",
    encoding: "json",
    compression: "gzip",
    data: gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 6 }),
    createdAt: input.createdAt,
  })
  return manifest
}

export async function loadRequest(store: Store, generationID: string): Promise<LoadedRequest | undefined> {
  const stored = await store.artifact(manifestArtifactID(generationID))
  if (!stored || stored.truncated) return undefined
  const manifest = JSON.parse(decodeText(stored)) as Partial<RequestManifest> | null
  if (manifest?.version !== 2 || !Array.isArray(manifest.components) || !Array.isArray(manifest.keys)) return undefined
  const missing: string[] = []
  const media = new Map<string, Buffer>()
  for (const item of manifest.media ?? []) {
    const artifact = await store.artifact(mediaArtifactID(item.sha256))
    const data = artifact && !artifact.truncated ? bytes(artifact.data) : undefined
    if (!data || sha256(data) !== item.sha256) {
      missing.push(item.sha256)
      continue
    }
    media.set(item.sha256, data)
  }
  let params: Record<string, unknown> = {}
  const parts: Record<string, unknown> = {}
  const messages: unknown[] = []
  for (const component of manifest.components) {
    const artifact = await store.artifact(componentArtifactID(component.sha256))
    const text = artifact && !artifact.truncated ? decodeText(artifact) : undefined
    if (text === undefined || sha256(text) !== component.sha256) {
      missing.push(component.sha256)
      continue
    }
    const value = JSON.parse(text) as unknown
    if (component.kind === "message") messages.push(inlineMedia(value, media))
    else if (component.kind === "params") params = value as Record<string, unknown>
    else parts[component.kind] = value
  }
  const hasMessages = manifest.components.some((component) => component.kind === "message")
  const body: Record<string, unknown> = {}
  for (const key of manifest.keys) {
    if ((key === "system" || key === "tools") && key in parts) body[key] = parts[key]
    else if (key === "messages" && hasMessages) body.messages = messages
    else if (key in params) body[key] = params[key]
  }
  const verified = missing.length === 0 && sha256(JSON.stringify(body)) === manifest.bodyHash
  return { manifest: manifest as RequestManifest, body, missing, verified }
}

export * as ArenaRequestManifest from "./request-manifest"
