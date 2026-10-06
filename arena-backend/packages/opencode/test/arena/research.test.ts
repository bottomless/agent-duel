import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { ResearchUploader, type ResearchUploadWarning } from "../../src/arena/research"
import {
  decodeResearchBatch,
  MAX_RESEARCH_RECORD_BYTES,
  projectResearchMutation,
  projectResearchRecords,
  RESEARCH_IMAGE_REFERENCE,
  type ResearchBatch,
  type ResearchMutation,
  type ResearchRecord,
} from "@agent-duel/arena-service/research-protocol"
import { ArenaTranscriptArtifact } from "../../src/arena/transcript-artifact"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function mutation(revision: number, id = "run-a"): ResearchMutation {
  return { collection: "runs", id, revision, document: { _id: id, terminal: "pending", toolCount: revision } }
}

/** Random bytes do not compress, like the photos and screenshots a battle carries. */
function image(bytes = 450 * 1024) {
  return `data:image/png;base64,${randomBytes(bytes).toString("base64")}`
}

/** A run's transcript artifact as the engine stores it: archived sessions, gzipped JSON. */
function transcript(id: string, images: readonly string[]): ResearchMutation {
  const archived = [
    {
      sessionID: `ses_${id}`,
      messages: [
        {
          info: { id: "msg_1", role: "user" },
          parts: [
            { type: "text", text: "Describe these." },
            ...images.map((url, index) => ({
              type: "file",
              mime: "image/png",
              filename: `attachment-${index + 1}.png`,
              url,
            })),
          ],
        },
        {
          info: { id: "msg_2", role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "read",
              state: { status: "completed", attachments: [{ type: "file", url: images[0] }] },
            },
          ],
        },
      ],
    },
  ]
  const encoded = ArenaTranscriptArtifact.encode(archived)
  return {
    collection: "artifacts",
    id: `${id}|transcript`,
    revision: 1,
    document: {
      _id: `${id}|transcript`,
      kind: "transcript",
      mimeType: "application/json",
      encoding: "json",
      compression: encoded.compression,
      data: encoded.data,
      originalSize: encoded.originalSize,
      storedSize: encoded.data.byteLength,
    },
  }
}

function decodedTranscript(record: ResearchRecord) {
  const data = record.document?.data
  if (typeof data !== "string") throw new Error("expected base64 transcript data")
  return JSON.parse(gunzipSync(Buffer.from(data, "base64")).toString("utf8")) as unknown
}

function uploader(
  server: ReturnType<typeof Bun.serve>,
  options: Partial<ConstructorParameters<typeof ResearchUploader>[0]> = {},
) {
  const warnings: ResearchUploadWarning[] = []
  const stream = new ResearchUploader({
    url: server.url.toString(),
    token: "test-session",
    sourceID: randomUUID(),
    intervalMs: 60_000,
    warn: (warning) => warnings.push(warning),
    ...options,
  })
  cleanup.push(() => stream.close())
  return { stream, warnings }
}

describe("continuous research uploads", () => {
  test("uploads an active run on the timer and accepts more local changes while the server is waiting", async () => {
    const received = Promise.withResolvers<ResearchBatch>()
    const release = Promise.withResolvers<void>()
    const batches: ResearchBatch[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer test-session")
        const batch = decodeResearchBatch(await request.text())
        batches.push(batch)
        received.resolve(batch)
        await release.promise
        return Response.json({ accepted: batch.records.length })
      },
    })
    cleanup.push(() => {
      release.resolve()
      server.stop(true)
    })
    const { stream } = uploader(server, { intervalMs: 5 })
    expect(stream.enqueue(mutation(1))).toBeUndefined()
    const first = await received.promise
    expect(first.records[0]?.document).toEqual({ _id: "run-a", terminal: "pending", toolCount: 1 })
    const inFlight = stream.flush()
    stream.enqueue(mutation(2))
    stream.enqueue(mutation(3))
    expect(stream.bufferedRecords).toBe(1)
    expect(stream.flush()).toBe(inFlight)
    release.resolve()
    await inFlight
    await stream.flush()
    expect(batches.map((batch) => batch.records.map((record) => record.revision))).toEqual([[1], [3]])
    expect(stream.bufferedBytes).toBe(0)
  })

  test("drops a failed batch and sends subsequent changes without replaying it", async () => {
    const batches: ResearchBatch[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        batches.push(decodeResearchBatch(await request.text()))
        return new Response(null, { status: batches.length === 1 ? 503 : 200 })
      },
    })
    cleanup.push(() => server.stop(true))
    const { stream, warnings } = uploader(server)
    stream.enqueue(mutation(1))
    await stream.flush()
    expect(stream.bufferedRecords).toBe(0)
    stream.enqueue(mutation(2))
    await stream.flush()
    expect(batches.map((batch) => batch.records[0]?.revision)).toEqual([1, 2])
    expect(warnings).toEqual([{ reason: "upload_failed", records: 1, bytes: expect.any(Number), status: 503 }])
  })

  test("bounds pending memory and times out an unresponsive request", async () => {
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        received.resolve()
        await release.promise
        return new Response(null)
      },
    })
    cleanup.push(() => {
      release.resolve()
      server.stop(true)
    })
    const recordBytes = Buffer.byteLength(JSON.stringify(projectResearchMutation(mutation(1))))
    const { stream, warnings } = uploader(server, { timeoutMs: 50, maxBufferBytes: recordBytes })
    stream.enqueue(mutation(1))
    const inFlight = stream.flush()
    await received.promise
    stream.enqueue(mutation(2))
    stream.enqueue(mutation(3, "run-b"))
    expect(stream.bufferedRecords).toBe(1)
    expect(stream.bufferedBytes).toBe(recordBytes)
    await inFlight
    expect(warnings.map((warning) => warning.reason)).toEqual(["buffer_full", "upload_failed"])
    release.resolve()
    await stream.flush()
    expect(stream.bufferedBytes).toBe(0)
  })

  test("keeps event content and generation metadata but excludes raw events and per-call artifacts", () => {
    const excluded = ["generation_request", "generation_response", "tool_output", "other"]
    for (const kind of excluded) {
      expect(
        projectResearchMutation({
          collection: "artifacts",
          id: kind,
          revision: 1,
          document: { kind, data: Buffer.from("private request") },
        }),
      ).toBeUndefined()
    }
    expect(projectResearchMutation({ ...mutation(1), collection: "rawEvents" })).toBeUndefined()
    expect(
      projectResearchMutation({
        collection: "generations",
        id: "call",
        revision: 1,
        document: {
          _id: "call",
          userId: "local-owner",
          requestArtifactID: "request",
          responseArtifactID: "response",
          usage: { cost: 0.1 },
        },
      })?.document,
    ).toEqual({ _id: "call", usage: { cost: 0.1 } })
    expect(
      projectResearchMutation({
        collection: "events",
        id: "event",
        revision: 2,
        document: { type: "message.part.updated", payload: { tool: "bash", output: "tests passed" } },
      })?.document,
    ).toEqual({ type: "message.part.updated", payload: { tool: "bash", output: "tests passed" } })
    expect(
      projectResearchMutation({
        collection: "artifacts",
        id: "transcript",
        revision: 3,
        document: { kind: "transcript", data: Buffer.from("hello"), path: "/local/path" },
      })?.document,
    ).toEqual({ kind: "transcript", data: "aGVsbG8=", dataEncoding: "base64" })
  })

  test("a transcript's images go as their own records, so a transcript with many images is no longer dropped", () => {
    const images = Array.from({ length: 6 }, () => image())
    const mutation = transcript("run-a", images)
    // Inline, the six images put the transcript's research record over the limit.
    const inline = projectResearchMutation(mutation)
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(MAX_RESEARCH_RECORD_BYTES)

    const records = projectResearchRecords(mutation)
    const imageRecords = records.filter((record) => record.collection === "images")
    const transcriptRecord = records.at(-1)!
    expect(imageRecords).toHaveLength(6)
    expect(transcriptRecord.collection).toBe("artifacts")
    for (const record of records)
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(MAX_RESEARCH_RECORD_BYTES)
    expect(transcriptRecord.document?.imageIDs).toEqual(imageRecords.map((record) => record.id))
    expect(imageRecords[0]?.document).toMatchObject({
      mimeType: "image/png",
      byteSize: 450 * 1024,
      dataEncoding: "base64",
    })

    // Putting each image back where its reference is gives the original transcript.
    const byID = new Map(imageRecords.map((record) => [record.id, `data:image/png;base64,${record.document?.data}`]))
    const restored = JSON.parse(
      JSON.stringify(decodedTranscript(transcriptRecord)).replace(
        new RegExp(`${RESEARCH_IMAGE_REFERENCE}([0-9a-f]{64})`, "g"),
        (_, id: string) => byID.get(id)!,
      ),
    )
    const original = projectResearchMutation(mutation)!
    expect(restored).toEqual(decodedTranscript(original))
  })

  test("both sides' transcripts send a shared image once", async () => {
    const batches: ResearchBatch[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        batches.push(decodeResearchBatch(await request.text()))
        return Response.json({})
      },
    })
    cleanup.push(() => server.stop(true))
    const { stream, warnings } = uploader(server)
    const shared = [image(), image()]
    stream.enqueue(transcript("run-a", shared))
    stream.enqueue(transcript("run-b", shared))
    while (stream.bufferedRecords > 0) await stream.flush()
    const records = batches.flatMap((batch) => batch.records)
    expect(records.filter((record) => record.collection === "images")).toHaveLength(2)
    expect(records.filter((record) => record.collection === "artifacts").map((record) => record.id)).toEqual([
      "run-a|transcript",
      "run-b|transcript",
    ])
    expect(warnings).toEqual([])
  })

  test("an image too large to send is dropped on its own and the transcript still goes", async () => {
    const batches: ResearchBatch[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        batches.push(decodeResearchBatch(await request.text()))
        return Response.json({})
      },
    })
    cleanup.push(() => server.stop(true))
    const { stream, warnings } = uploader(server)
    stream.enqueue(transcript("run-a", [image(), image(2 * 1024 * 1024)]))
    while (stream.bufferedRecords > 0) await stream.flush()
    const records = batches.flatMap((batch) => batch.records)
    expect(records.map((record) => record.collection)).toEqual(["images", "artifacts"])
    expect(warnings).toEqual([{ reason: "oversized_record", records: 1, bytes: expect.any(Number) }])
  })
})
