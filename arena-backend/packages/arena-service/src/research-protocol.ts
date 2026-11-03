import { createHash } from "node:crypto"
import { z } from "zod"
import type { ArenaMutation } from "./collection"

export const MAX_RESEARCH_BATCH_BYTES = 3 * 1024 * 1024
export const MAX_RESEARCH_RECORD_BYTES = 2 * 1024 * 1024
export const MAX_RESEARCH_BATCH_RECORDS = 100

export const researchCollections = [
  "chats",
  "turns",
  "runs",
  "generations",
  "events",
  "sessionArchives",
  "comparisons",
  "reviewEvents",
  "battleMetrics",
  "singleAgentRatings",
  "artifacts",
  "images",
  "chunks",
] as const

const collectionSchema = z.enum(researchCollections)
const documentSchema = z.record(z.string(), z.unknown())
const recordSchema = z.object({
  collection: collectionSchema,
  id: z.string().min(1).max(2048),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  document: documentSchema.nullable(),
})
const batchSchema = z.object({
  version: z.literal(1),
  sourceID: z.string().uuid(),
  records: z.array(recordSchema).min(1).max(MAX_RESEARCH_BATCH_RECORDS),
})

export type ResearchCollection = z.infer<typeof collectionSchema>
export type ResearchRecord = z.infer<typeof recordSchema>
export type ResearchBatch = z.infer<typeof batchSchema>

export type ResearchMutation = ArenaMutation

export class ResearchPayloadError extends Error {
  override readonly name = "ResearchPayloadError"
}

function researchDocument(collection: ResearchCollection, document: Readonly<Record<string, unknown>>) {
  if ("$researchChunks" in document) {
    return chunkManifestSchema.parse(document)
  }
  if (collection === "chunks") return chunkSchema.parse(document)
  const result = { ...document }
  // The backend authenticates the envelope; local ownership is not an assertion
  // about which account may write a server-side record.
  delete result.userId
  delete result.accountId
  if (collection === "generations" || collection === "comparisons") {
    const omitted = [result.requestArtifactID, result.responseArtifactID]
    delete result.requestArtifactID
    delete result.responseArtifactID
    if (Array.isArray(result.artifactIDs)) result.artifactIDs = result.artifactIDs.filter((id) => !omitted.includes(id))
  }
  if (collection === "artifacts") {
    if (result.kind !== "transcript" && result.kind !== "patch") {
      throw new ResearchPayloadError("This artifact kind is not collected for research")
    }
    if (result.data instanceof Uint8Array) {
      result.data = Buffer.from(result.data).toString("base64")
      result.dataEncoding = "base64"
    }
    if (typeof result.data !== "string" || result.dataEncoding !== "base64") {
      throw new ResearchPayloadError("Research artifact bytes must be base64 encoded")
    }
    delete result.path
  }
  if (collection === "images") {
    if (typeof result.mimeType !== "string" || !result.mimeType.startsWith("image/")) {
      throw new ResearchPayloadError("A research image must name an image type")
    }
    if (typeof result.data !== "string" || result.dataEncoding !== "base64") {
      throw new ResearchPayloadError("Research image bytes must be base64 encoded")
    }
  }
  return result
}

export function projectResearchMutation(mutation: ResearchMutation): ResearchRecord | undefined {
  const collection = collectionSchema.safeParse(mutation.collection)
  if (!collection.success) return undefined
  const document = mutation.document
  // Reply resets delete local archives before writing their replacement. Keep the last cloud copy
  // until the new revision (and all its chunks) has been acknowledged.
  const archiveReset =
    document === null &&
    (collection.data === "sessionArchives" || (collection.data === "artifacts" && mutation.id.endsWith("|transcript")))
  if (archiveReset) return undefined
  const excludedArtifact =
    collection.data === "artifacts" && document !== null && document.kind !== "transcript" && document.kind !== "patch"
  if (excludedArtifact) return undefined
  return {
    collection: collection.data,
    id: mutation.id,
    revision: mutation.revision,
    document: document === null ? null : researchDocument(collection.data, document),
  }
}

/** What a transcript holds in place of an image: the image named by the SHA-256 of its bytes. */
export const RESEARCH_IMAGE_REFERENCE = "arena-image:sha256:"
const IMAGE_DATA_URL = /^data:(image\/[^;,]+);base64,/
const IMAGE_ARTIFACT_ID = /\|image\|[0-9a-f]{64}$/

export type TranscriptImage = { readonly id: string; readonly mimeType: string; readonly bytes: Buffer }

/** Rewrites every `url` string in a transcript, leaving the rest as it is. */
function replaceUrls(value: unknown, replace: (url: string) => string | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceUrls(item, replace))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const replaced = key === "url" && typeof entry === "string" ? replace(entry) : undefined
      return [key, replaced ?? replaceUrls(entry, replace)]
    }),
  )
}

/**
 * A session keeps each image inline as a base64 data URL, a pasted one and every screenshot a
 * contestant reads, so a long run's transcript is mostly images. This names each image by the SHA-256
 * of its bytes in its place, and returns the images once each, in the order they first appear.
 */
export function externalizeImages(value: unknown) {
  const images = new Map<string, TranscriptImage>()
  const externalized = replaceUrls(value, (url) => {
    const match = IMAGE_DATA_URL.exec(url)
    const mimeType = match?.[1]
    if (!match || !mimeType) return undefined
    const bytes = Buffer.from(url.slice(match[0].length), "base64")
    const id = createHash("sha256").update(bytes).digest("hex")
    if (!images.has(id)) images.set(id, { id, mimeType, bytes })
    return `${RESEARCH_IMAGE_REFERENCE}${id}`
  })
  return { value: externalized, images: [...images.values()] }
}

/** The IDs of the images a transcript names in place of their bytes, once each. */
export function namedImages(value: unknown) {
  const ids = new Set<string>()
  replaceUrls(value, (url) => {
    if (url.startsWith(RESEARCH_IMAGE_REFERENCE)) ids.add(url.slice(RESEARCH_IMAGE_REFERENCE.length))
    return undefined
  })
  return [...ids]
}

/** Puts back each image `externalizeImages` named. A name `images` does not hold stays as it is. */
export function inlineImages(value: unknown, images: ReadonlyMap<string, Omit<TranscriptImage, "id">>) {
  return replaceUrls(value, (url) => {
    const image = url.startsWith(RESEARCH_IMAGE_REFERENCE)
      ? images.get(url.slice(RESEARCH_IMAGE_REFERENCE.length))
      : undefined
    return image ? `data:${image.mimeType};base64,${image.bytes.toString("base64")}` : undefined
  })
}

/** The artifact a run keeps one of its transcript's images in, by the image's ID. */
export function imageArtifactID(runID: string, imageID: string) {
  return `${runID}|image|${imageID}`
}

/**
 * A transcript image goes as its own `images` record, named by its content: inline, a few large ones
 * put the transcript over MAX_RESEARCH_RECORD_BYTES and the uploader dropped all of it. Both sides'
 * copies of an image are one record, and the first one stored stands, so removing one run's copy
 * removes nothing: the other side's transcript can still name it.
 */
function imageRecords(mutation: ResearchMutation): ResearchRecord[] | undefined {
  if (mutation.collection !== "artifacts") return undefined
  const document = mutation.document
  if (document === null) return IMAGE_ARTIFACT_ID.test(mutation.id) ? [] : undefined
  if (document.kind !== "image") return undefined
  const { contentHash, data, mimeType } = document
  if (document.truncated || typeof contentHash !== "string" || !(data instanceof Uint8Array)) return []
  const image = {
    _id: contentHash,
    mimeType,
    byteSize: data.byteLength,
    data: Buffer.from(data).toString("base64"),
    dataEncoding: "base64",
  }
  return [{ collection: "images", id: contentHash, revision: 1, document: researchDocument("images", image) }]
}

/**
 * The research records one local change becomes: none for data that is not collected, an image's
 * `images` record, or the record itself.
 */
export function projectResearchRecords(mutation: ResearchMutation): ResearchRecord[] {
  const images = imageRecords(mutation)
  if (images) return images
  const record = projectResearchMutation(mutation)
  return record ? [record] : []
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const chunkSchema = z.object({ data: z.string(), dataEncoding: z.literal("base64") }).strict()
const chunkManifestSchema = z
  .object({
    $researchChunks: z
      .object({
        version: z.literal(1),
        sha256: hashSchema,
        byteLength: z.number().int().positive(),
        ids: z.array(hashSchema).min(1),
      })
      .strict(),
  })
  .strict()
const CHUNK_BYTES = 1024 * 1024

/** A large document is published only after every content-addressed chunk ahead of it is stored. */
export function researchWireRecords(record: ResearchRecord): ResearchRecord[] {
  if (Buffer.byteLength(JSON.stringify(record)) <= MAX_RESEARCH_RECORD_BYTES) return [record]
  const bytes = Buffer.from(JSON.stringify(record.document))
  const chunks: ResearchRecord[] = []
  const ids: string[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + CHUNK_BYTES)
    const id = createHash("sha256").update(part).digest("hex")
    ids.push(id)
    chunks.push({
      collection: "chunks",
      id,
      revision: 1,
      document: { data: part.toString("base64"), dataEncoding: "base64" },
    })
  }
  const manifest: ResearchRecord = {
    ...record,
    document: {
      $researchChunks: {
        version: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
        ids,
      },
    },
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_RESEARCH_RECORD_BYTES)
    throw new ResearchPayloadError("Research chunk manifest is too large")
  return [...chunks, manifest]
}

/** Readers must resolve chunks in the same authenticated account/source scope as the snapshot. */
export async function resolveResearchDocument(
  document: Record<string, unknown> | null,
  readChunk: (id: string) => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown> | null> {
  if (document === null || !("$researchChunks" in document)) return document
  const manifest = chunkManifestSchema.parse(document).$researchChunks
  const parts: Buffer[] = []
  for (const id of manifest.ids) {
    const chunk = chunkSchema.parse(await readChunk(id))
    const part = Buffer.from(chunk.data, "base64")
    if (createHash("sha256").update(part).digest("hex") !== id)
      throw new ResearchPayloadError("Research chunk checksum mismatch")
    parts.push(part)
  }
  const bytes = Buffer.concat(parts)
  if (bytes.length !== manifest.byteLength || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    throw new ResearchPayloadError("Research document checksum mismatch")
  return documentSchema.parse(JSON.parse(bytes.toString("utf8")))
}

export function encodeResearchBatch(batch: ResearchBatch) {
  return JSON.stringify(batch)
}

export function decodeResearchBatch(text: string): ResearchBatch {
  if (Buffer.byteLength(text) > MAX_RESEARCH_BATCH_BYTES) throw new ResearchPayloadError("Research batch is too large")
  const parsed = batchSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new ResearchPayloadError("Invalid research batch")
  const records = parsed.data.records.map((record) => {
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RESEARCH_RECORD_BYTES) {
      throw new ResearchPayloadError("Research record is too large")
    }
    return {
      ...record,
      document: record.document === null ? null : researchDocument(record.collection, record.document),
    }
  })
  return { ...parsed.data, records }
}
