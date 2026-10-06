import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
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

/** What a transcript's research copy holds in place of an image: the `images` record with these bytes. */
export const RESEARCH_IMAGE_REFERENCE = "arena-image:sha256:"
const IMAGE_DATA_URL = /^data:(image\/[^;,]+);base64,/

/**
 * A transcript keeps each image inline as a base64 data URL, so a few large images put its research
 * copy over MAX_RESEARCH_RECORD_BYTES and the uploader drops the whole transcript. Each image goes as
 * its own `images` record named by the SHA-256 of its bytes, and the transcript names it instead.
 * Both contestants are sent the same bytes, so a battle's images are uploaded once.
 *
 * The local artifact is untouched; its `originalSize`, `storedSize`, and `contentHash` still describe
 * it, and `imageIDs` lists the images taken out of `data`, in the order they first appear.
 */
function externalizeTranscriptImages(mutation: ResearchMutation): ResearchMutation[] {
  const document = mutation.document
  if (
    mutation.collection !== "artifacts" ||
    document?.kind !== "transcript" ||
    document.compression !== "gzip" ||
    !(document.data instanceof Uint8Array)
  ) {
    return [mutation]
  }
  let transcript: unknown
  try {
    transcript = JSON.parse(gunzipSync(document.data).toString("utf8"))
  } catch {
    return [mutation]
  }
  const images = new Map<string, ResearchMutation>()
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const match = key === "url" && typeof entry === "string" ? IMAGE_DATA_URL.exec(entry) : null
        if (!match) return [key, replace(entry)]
        const data = entry.slice(match[0].length)
        const bytes = Buffer.from(data, "base64")
        const id = createHash("sha256").update(bytes).digest("hex")
        if (!images.has(id)) {
          images.set(id, {
            collection: "images",
            id,
            // Named by its content, so every copy is the same record and the first one stored stands.
            revision: 1,
            document: { _id: id, mimeType: match[1], byteSize: bytes.byteLength, data, dataEncoding: "base64" },
          })
        }
        return [key, `${RESEARCH_IMAGE_REFERENCE}${id}`]
      }),
    )
  }
  const externalized = replace(transcript)
  if (images.size === 0) return [mutation]
  return [
    ...images.values(),
    {
      ...mutation,
      document: {
        ...document,
        data: gzipSync(Buffer.from(JSON.stringify(externalized)), { level: 6 }),
        imageIDs: [...images.keys()],
      },
    },
  ]
}

/**
 * The research records one local change becomes: none for data that is not collected, the record
 * itself, or for a transcript with images, the images first and then the transcript that names them.
 */
export function projectResearchRecords(mutation: ResearchMutation): ResearchRecord[] {
  return externalizeTranscriptImages(mutation).flatMap((item) => projectResearchMutation(item) ?? [])
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
