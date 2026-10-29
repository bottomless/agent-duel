import { createHash } from "crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { externalizeImages, inlineImages } from "@agent-duel/arena-service/research-protocol"
import type { Store } from "./mongo"
import type { ArtifactDocument } from "./records"

export type RequestComponentKind = "params" | "system" | "tools" | "message"

export type RequestComponent = {
  readonly kind: RequestComponentKind
  readonly role?: string
  readonly sha256: string
  readonly bytes: number
}

export type RequestImage = {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
}

export type RequestManifest = {
  readonly version: 1
  readonly generationID: string
  readonly bodyHash: string
  readonly components: ReadonlyArray<RequestComponent>
  readonly images: ReadonlyArray<RequestImage>
}

type SplitComponent = RequestComponent & { readonly value: unknown }
type SplitImage = RequestImage & { readonly data: Buffer }

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

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((child) => stable(child)).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

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

function decode(artifact: ArtifactDocument): unknown {
  const data = bytes(artifact.data)
  return JSON.parse((artifact.compression === "gzip" ? gunzipSync(data) : data).toString("utf8")) as unknown
}

export function componentArtifactID(runID: string, sha256Digest: string) {
  return `${runID}|component|${sha256Digest}`
}

export function manifestArtifactID(generationID: string) {
  return `${generationID}|manifest`
}

function componentOf(kind: RequestComponentKind, value: unknown, role?: string): SplitComponent {
  const canonical = stable(value)
  return {
    kind,
    ...(role ? { role } : {}),
    sha256: sha256(canonical),
    bytes: Buffer.byteLength(canonical),
    value,
  }
}

export function splitRequest(body: Readonly<Record<string, unknown>>) {
  const params: Record<string, unknown> = {}
  const components: SplitComponent[] = []
  const images = new Map<string, SplitImage>()
  for (const [key, value] of Object.entries(body)) {
    if (key === "system" || key === "tools") continue
    if (key === "messages" && Array.isArray(value) && value.length > 0) continue
    params[key] = value
  }
  components.push(componentOf("params", params))
  if ("system" in body) components.push(componentOf("system", body.system))
  if ("tools" in body) components.push(componentOf("tools", body.tools))
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const message of body.messages) {
      const externalized = externalizeImages(message)
      for (const image of externalized.images) {
        if (images.has(image.id)) continue
        images.set(image.id, {
          sha256: image.id,
          mimeType: image.mimeType,
          bytes: image.bytes.byteLength,
          data: image.bytes,
        })
      }
      const role = (message as { role?: unknown } | null)?.role
      components.push(componentOf("message", externalized.value, typeof role === "string" ? role : undefined))
    }
  }
  return { components, images: [...images.values()] }
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
  for (const image of split.images) {
    await write(
      componentArtifactID(input.runID, image.sha256),
      { mimeType: image.mimeType, encoding: "binary", compression: "none" },
      () => image.data,
    )
  }
  for (const component of split.components) {
    await write(
      componentArtifactID(input.runID, component.sha256),
      { mimeType: "application/json", encoding: "json", compression: "gzip" },
      () => gzipSync(Buffer.from(JSON.stringify(component.value)), { level: 6 }),
    )
  }
  const manifest: RequestManifest = {
    version: 1,
    generationID: input.generationID,
    bodyHash: sha256(stable(input.body)),
    components: split.components.map(({ kind, role, sha256: digest, bytes: size }) => ({
      kind,
      ...(role ? { role } : {}),
      sha256: digest,
      bytes: size,
    })),
    images: split.images.map(({ sha256: digest, mimeType, bytes: size }) => ({
      sha256: digest,
      mimeType,
      bytes: size,
    })),
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

export async function loadRequest(
  store: Store,
  runID: string,
  generationID: string,
): Promise<LoadedRequest | undefined> {
  const stored = await store.artifact(manifestArtifactID(generationID))
  if (!stored || stored.truncated) return undefined
  const decoded = decode(stored) as Partial<RequestManifest> | null
  if (!decoded || !Array.isArray(decoded.components)) return undefined
  const manifest = { ...decoded, images: decoded.images ?? [] } as RequestManifest
  const missing: string[] = []
  const images = new Map<string, { readonly mimeType: string; readonly bytes: Buffer }>()
  for (const image of manifest.images) {
    const artifact = await store.artifact(componentArtifactID(runID, image.sha256))
    const data = artifact && !artifact.truncated ? bytes(artifact.data) : undefined
    if (!data || sha256(data) !== image.sha256) {
      missing.push(image.sha256)
      continue
    }
    images.set(image.sha256, { mimeType: image.mimeType, bytes: data })
  }
  const body: Record<string, unknown> = {}
  const messages: unknown[] = []
  for (const component of manifest.components) {
    const artifact = await store.artifact(componentArtifactID(runID, component.sha256))
    const value = artifact && !artifact.truncated ? decode(artifact) : undefined
    if (value === undefined || sha256(stable(value)) !== component.sha256) {
      missing.push(component.sha256)
      continue
    }
    if (component.kind === "message") messages.push(inlineImages(value, images))
    else if (component.kind === "system") body.system = value
    else if (component.kind === "tools") body.tools = value
    else Object.assign(body, value as Record<string, unknown>)
  }
  if (manifest.components.some((component) => component.kind === "message")) body.messages = messages
  const verified = missing.length === 0 && sha256(stable(body)) === manifest.bodyHash
  return { manifest, body, missing, verified }
}

export * as ArenaRequestManifest from "./request-manifest"
