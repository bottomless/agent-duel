import { gunzipSync, gzipSync } from "node:zlib"
import {
  externalizeImages,
  imageArtifactID,
  inlineImages,
  namedImages,
} from "@agent-duel/arena-service/research-protocol"
import type { Store } from "./mongo"
import type { ArtifactDocument } from "./records"

type TranscriptArtifact = Pick<ArtifactDocument, "compression" | "data"> & { readonly truncated?: boolean }

function bytes(data: Buffer) {
  if (Buffer.isBuffer(data)) return data
  const binary = data as unknown as { readonly buffer?: Uint8Array }
  if (binary.buffer instanceof Uint8Array) return Buffer.from(binary.buffer)
  throw new Error("Arena transcript artifact has an unsupported binary payload")
}

export function encode(value: unknown) {
  const source = Buffer.from(JSON.stringify(value))
  return {
    compression: "gzip" as const,
    data: gzipSync(source, { level: 6 }),
    originalSize: source.byteLength,
  }
}

export function decode(artifact: TranscriptArtifact): unknown {
  // A gzip stream is stored whole or not at all; one cut short by an older build does not decode either.
  if (artifact.truncated)
    throw new Error("Arena transcript archive was larger than the artifact limit and was not kept")
  const data = bytes(artifact.data)
  const decoded = artifact.compression === "gzip" ? gunzipSync(data) : data
  return JSON.parse(decoded.toString("utf8")) as unknown
}

/**
 * Stores a run's archived sessions as its transcript, with each image the sessions hold as its own
 * artifact. A session holds its images inline, a pasted one and every screenshot the contestant read,
 * so a long run's transcript was mostly images: over the artifact limit it was not kept, and the turn
 * had no transcript to compare. Kept by content, an image both sides read is also one file.
 */
export async function write(
  store: Store,
  input: { readonly runID: string; readonly turnID: string; readonly archived: unknown },
) {
  const { value, images } = externalizeImages(input.archived)
  const encoded = encode(value)
  const createdAt = new Date()
  const transcript = await store.storeArtifact({
    _id: `${input.runID}|transcript`,
    runID: input.runID,
    turnID: input.turnID,
    kind: "transcript",
    mimeType: "application/json",
    encoding: "json",
    compression: encoded.compression,
    data: encoded.data,
    ...(images.length ? { imageIDs: images.map((image) => image.id) } : {}),
    createdAt,
  })
  for (const image of images) {
    await store.storeArtifact({
      _id: imageArtifactID(input.runID, image.id),
      runID: input.runID,
      turnID: input.turnID,
      kind: "image",
      mimeType: image.mimeType,
      encoding: "binary",
      compression: "none",
      data: image.bytes,
      createdAt,
    })
  }
  return {
    transcript,
    originalSize: encoded.originalSize,
    artifactIDs: [transcript._id, ...images.map((image) => imageArtifactID(input.runID, image.id))],
  }
}

/** Puts back the images `value` still names, from the run's archive, for a reader that shows them. */
export async function withImages<T>(store: Store, runID: string, value: T): Promise<T> {
  const ids = namedImages(value)
  if (!ids.length) return value
  const images = await Promise.all(
    ids.map(async (id) => {
      const image = await store.artifact(imageArtifactID(runID, id))
      return image && !image.truncated ? [[id, { mimeType: image.mimeType, bytes: bytes(image.data) }] as const] : []
    }),
  )
  return inlineImages(value, new Map(images.flat())) as T
}

export * as ArenaTranscriptArtifact from "./transcript-artifact"
