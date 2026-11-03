import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { ResearchQueue } from "../../src/arena/research-queue"
import { ResearchUploader, type ResearchUploadOptions } from "../../src/arena/research"
import { connectLocalStore } from "../../src/arena/local-store"
import { ArenaTranscriptArtifact } from "../../src/arena/transcript-artifact"
import { tmpdir } from "../fixture/fixture"
import {
  decodeResearchBatch,
  projectResearchMutation,
  projectResearchRecords,
  resolveResearchDocument,
  MAX_RESEARCH_RECORD_BYTES,
  MAX_RESEARCH_BATCH_BYTES,
  type ResearchMutation,
  type ResearchRecord,
} from "@agent-duel/arena-service/research-protocol"

function requestBatch(init: RequestInit) {
  if (typeof init.body !== "string") throw new Error("Expected serialized research batch")
  return decodeResearchBatch(init.body)
}

function mutation(revision: number, id = "run-a"): ResearchMutation {
  return { collection: "runs", id, revision, document: { _id: id, toolCount: revision } }
}

function fixture(options: Partial<ResearchUploadOptions> = {}) {
  const database = new Database(":memory:")
  const queue = new ResearchQueue(database, "account-a")
  const batches: ResearchRecord[][] = []
  let now = 1000
  const uploader = new ResearchUploader({
    url: "https://control.test",
    token: "test-token",
    sourceID: randomUUID(),
    queue,
    intervalMs: 60_000,
    now: () => now,
    random: () => 1,
    warn: () => {},
    fetch: async (_url, init) => {
      const batch = requestBatch(init)
      batches.push(batch.records)
      return Response.json({ received: batch.records.length, stored: batch.records.length })
    },
    ...options,
  })
  return {
    queue,
    uploader,
    batches,
    database,
    advance() {
      now = queue.retry().nextAttempt
    },
    setTime(value: number) {
      now = value
    },
    async [Symbol.asyncDispose]() {
      await uploader.close()
      database.close()
    },
  }
}

describe("durable research uploads", () => {
  test("automatically uploads parked records after cloud repair without another local write", async () => {
    const recovered = Promise.withResolvers<void>()
    let attempts = 0
    await using f = fixture({
      intervalMs: 1,
      rejectedRetryMs: 10,
      now: Date.now,
      fetch: async (_url, init) => {
        attempts++
        if (attempts === 1) return new Response(null, { status: 400 })
        const batch = requestBatch(init)
        expect(batch.records.map((record) => record.id)).toEqual(["run-a"])
        recovered.resolve()
        return Response.json({ received: 1, stored: 1 })
      },
    })
    f.queue.enqueue(mutation(1))
    await f.uploader.flush()
    expect(f.queue.rejected().map((record) => record.id)).toEqual(["run-a"])
    await recovered.promise
    await f.uploader.flush()
    expect(f.queue.count).toBe(0)
    expect(f.queue.rejected()).toEqual([])
    expect(attempts).toBe(2)
  })

  test("new writes wake promptly while rejected records wait for recovery", async () => {
    const uploaded = Promise.withResolvers<void>()
    await using f = fixture({
      intervalMs: 1,
      now: Date.now,
      fetch: async (_url, init) => {
        const batch = requestBatch(init)
        if (batch.records.some((record) => record.id === "bad")) return new Response(null, { status: 400 })
        expect(batch.records.map((record) => record.id)).toEqual(["good"])
        uploaded.resolve()
        return Response.json({ received: 1, stored: 1 })
      },
    })
    f.queue.enqueue(mutation(1, "bad"))
    await f.uploader.flush()
    f.queue.enqueue(mutation(2, "good"))
    f.uploader.wake()
    await uploaded.promise
    await f.uploader.flush()
    expect(f.queue.rejected().map((record) => record.id)).toEqual(["bad"])
    expect(f.queue.count).toBe(0)
  })

  test("restarts preserve rejected retry cooldowns and permanent rejection cannot block new writes", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "queue.sqlite")
    const sourceID = randomUUID()
    const accepted: string[] = []
    let now = 1000
    let rejectedAttempts = 0
    const options = {
      url: "https://control.test",
      token: "test",
      sourceID,
      intervalMs: 60_000,
      now: () => now,
      warn: () => {},
      fetch: async (_url: string, init: RequestInit) => {
        const batch = requestBatch(init)
        if (batch.records.some((record) => record.id === "bad")) {
          rejectedAttempts++
          return new Response(null, { status: 400 })
        }
        accepted.push(...batch.records.map((record) => record.id))
        return Response.json({ received: batch.records.length, stored: batch.records.length })
      },
    }
    const first = new Database(file)
    const initialQueue = new ResearchQueue(first, "account-a")
    const initial = new ResearchUploader({ ...options, queue: initialQueue })
    initialQueue.enqueue(mutation(1, "bad"))
    await initial.flush()
    await initial.close()
    first.close()

    const second = new Database(file)
    const queue = new ResearchQueue(second, "account-a")
    const uploader = new ResearchUploader({ ...options, queue })
    try {
      now += 60 * 60_000 - 1
      await uploader.flush()
      expect(rejectedAttempts).toBe(1)
      const other = new ResearchQueue(second, "account-b")
      expect(other.recoveryAt(now, 1)).toBeUndefined()
      now++
      await uploader.flush()
      expect(rejectedAttempts).toBe(2)
      await uploader.flush()
      expect(rejectedAttempts).toBe(2)
      queue.enqueue(mutation(2, "good"))
      await uploader.flush()
      expect(accepted).toEqual(["good"])
      expect(rejectedAttempts).toBe(2)
      expect(queue.recoveryAt(now, 1)).toBe(now + 60 * 60_000)
    } finally {
      await uploader.close()
      second.close()
    }
  })

  test("keeps failed records and retries with exponential capped backoff until acknowledged", async () => {
    let attempt = 0
    await using f = fixture({
      fetch: async (_url, init) => {
        attempt++
        const batch = requestBatch(init)
        if (attempt <= 10) return new Response(null, { status: 503 })
        return Response.json({ received: batch.records.length, stored: 0 })
      },
    })
    f.queue.enqueue(mutation(1))
    const delays: number[] = []
    let now = 1000
    for (let i = 0; i < 10; i++) {
      await f.uploader.flush()
      expect(f.queue.count).toBe(1)
      const retry = f.queue.retry()
      delays.push(retry.nextAttempt - now)
      await f.uploader.flush()
      expect(attempt).toBe(i + 1)
      now = retry.nextAttempt
      f.advance()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
    await f.uploader.flush()
    expect(f.queue.count).toBe(0)
    expect(f.queue.retry()).toEqual({ failures: 0, nextAttempt: 0 })
  })

  test.each([400, 413, 422])(
    "isolates a permanently rejected record on HTTP %s and uploads later records",
    async (status) => {
      const uploaded: string[] = []
      await using f = fixture({
        fetch: async (_url, init) => {
          const batch = requestBatch(init)
          if (batch.records.some((record) => record.id === "bad")) return new Response(null, { status })
          uploaded.push(...batch.records.map((record) => record.id))
          return Response.json({ received: batch.records.length, stored: batch.records.length })
        },
      })
      f.queue.enqueue(mutation(1, "bad"))
      f.queue.enqueue(mutation(2, "good"))
      await f.uploader.flush()
      expect(uploaded).toEqual(["good"])
      expect(f.queue.count).toBe(0)
      expect(f.queue.rejected().map((record) => ({ id: record.id, reason: record.reason }))).toEqual([
        { id: "bad", reason: `http_${status}` },
      ])
      await f.uploader.flush()
      expect(uploaded).toEqual(["good"])
    },
  )

  test.each([401, 403, 429, 500, 503])("retains every record on HTTP %s", async (status) => {
    await using f = fixture({ fetch: async () => new Response(null, { status }) })
    f.queue.enqueue(mutation(1))
    f.queue.enqueue(mutation(2))
    await f.uploader.flush()
    expect(f.queue.peek(10).map((x) => JSON.parse(x.json).revision)).toEqual([1, 2])
    expect(f.queue.retry().failures).toBe(1)
  })

  test("splits an oversized batch without rejecting individually acceptable records", async () => {
    const uploaded: string[] = []
    await using f = fixture({
      fetch: async (_url, init) => {
        const batch = requestBatch(init)
        if (batch.records.length > 1) return new Response(null, { status: 413 })
        uploaded.push(batch.records[0].id)
        return Response.json({ received: 1, stored: 1 })
      },
    })
    f.queue.enqueue(mutation(1, "first"))
    f.queue.enqueue(mutation(2, "second"))
    await f.uploader.flush()
    expect(uploaded).toEqual(["first", "second"])
    expect(f.queue.rejected()).toEqual([])
    expect(f.queue.count).toBe(0)
  })

  test("retains dependent manifests when a chunk is rejected, without blocking other records", async () => {
    const uploaded: ResearchRecord[] = []
    await using f = fixture({
      fetch: async (_url, init) => {
        const batch = requestBatch(init)
        if (batch.records.some((record) => record.collection === "chunks")) return new Response(null, { status: 400 })
        uploaded.push(...batch.records)
        return Response.json({ received: batch.records.length, stored: batch.records.length })
      },
    })
    f.queue.enqueue({ collection: "runs", id: "large", revision: 1, document: { text: "x".repeat(3 * 1024 * 1024) } })
    f.queue.enqueue(mutation(2, "good"))
    while (f.queue.count) await f.uploader.flush()
    expect(uploaded.map((record) => record.id)).toEqual(["good"])
    expect(f.queue.rejected().find((record) => record.id === "large")?.reason).toBe("rejected_chunk")
  })

  test("new archives sharing refused chunks stay parked instead of bypassing the retry cooldown", async () => {
    let attempts = 0
    let repaired = false
    const uploaded: ResearchRecord[] = []
    await using f = fixture({
      fetch: async (_url, init) => {
        attempts++
        const batch = requestBatch(init)
        if (!repaired && batch.records.some((record) => record.collection === "chunks"))
          return new Response(null, { status: 400 })
        uploaded.push(...batch.records)
        return Response.json({ received: batch.records.length, stored: batch.records.length })
      },
    })
    const document = { text: "x".repeat(3 * 1024 * 1024) }
    f.queue.enqueue({ collection: "runs", id: "first", revision: 1, document })
    while (f.queue.count) await f.uploader.flush()
    const before = attempts
    f.queue.enqueue({ collection: "runs", id: "second", revision: 1, document })
    while (f.queue.count) await f.uploader.flush()
    expect(attempts).toBe(before)
    expect(uploaded).toEqual([])
    expect(
      f.queue
        .rejected()
        .filter((record) => record.reason === "rejected_chunk")
        .map((record) => record.id),
    ).toEqual(["first", "second"])
    repaired = true
    f.setTime(1000 + 60 * 60_000)
    while (f.queue.rejected().length || f.queue.count) await f.uploader.flush()
    const chunks = new Map(
      uploaded.filter((record) => record.collection === "chunks").map((record) => [record.id, record.document]),
    )
    expect(uploaded.filter((record) => record.collection === "runs").map((record) => record.id)).toEqual([
      "first",
      "second",
    ])
    for (const record of uploaded.filter((record) => record.collection === "runs"))
      expect(await resolveResearchDocument(record.document, async (id) => chunks.get(id) ?? null)).toEqual(document)
  })

  test("rejected records survive reopening and can be explicitly retried after repair", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "queue.sqlite")
    const first = new Database(file)
    const queue = new ResearchQueue(first, "account-a")
    queue.enqueue(mutation(1))
    queue.reject(queue.peek(10), "http_400")
    first.close()
    const second = new Database(file)
    try {
      const reopened = new ResearchQueue(second, "account-a")
      expect(reopened.count).toBe(0)
      expect(reopened.rejected().map((row) => row.id)).toEqual(["run-a"])
      const other = new ResearchQueue(second, "account-b")
      expect(other.rejected()).toEqual([])
      other.retryRejected()
      reopened.retryRejected()
      expect(reopened.peek(10).map((row) => JSON.parse(row.json))).toEqual([mutation(1)])
      expect(reopened.rejected()).toEqual([])
    } finally {
      second.close()
    }
  })

  test.each([{}, { received: 0, stored: 0 }, { received: 1, stored: 2 }])(
    "requires a complete receipt, not merely HTTP 200: %j",
    async (receipt) => {
      await using f = fixture({ fetch: async () => Response.json(receipt) })
      f.queue.enqueue(mutation(1))
      await f.uploader.flush()
      expect(f.queue.count).toBe(1)
    },
  )

  test("retains a batch when transport fails", async () => {
    await using f = fixture({
      fetch: async () => {
        throw new TypeError("network unavailable")
      },
    })
    f.queue.enqueue(mutation(1))
    await f.uploader.flush()
    expect(f.queue.count).toBe(1)
    expect(f.queue.retry().failures).toBe(1)
  })

  test("acknowledging an in-flight batch does not remove newer queued revisions", async () => {
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    await using f = fixture({
      fetch: async () => {
        received.resolve()
        return release.promise
      },
    })
    f.queue.enqueue(mutation(1))
    const inFlight = f.uploader.flush()
    await received.promise
    f.queue.enqueue(mutation(2))
    f.queue.enqueue(mutation(3))
    expect(f.queue.count).toBe(3)
    expect(f.uploader.flush()).toBe(inFlight)
    release.resolve(Response.json({ received: 1, stored: 1 }))
    await inFlight
    expect(f.queue.peek(10).map((x) => JSON.parse(x.json).revision)).toEqual([2, 3])
  })

  test("closing during upload aborts transport and retains the records", async () => {
    const received = Promise.withResolvers<void>()
    await using f = fixture({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")))
          received.resolve()
        }),
    })
    f.queue.enqueue(mutation(1))
    void f.uploader.flush()
    await received.promise
    await f.uploader.close()
    expect(f.queue.count).toBe(1)
  })

  test("timeout retains the batch for retry", async () => {
    await using f = fixture({
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("timeout")))
        }),
    })
    f.queue.enqueue(mutation(1))
    await f.uploader.flush()
    expect(f.queue.count).toBe(1)
    expect(f.queue.retry().failures).toBe(1)
  })

  test("process restart retains payloads and retry deadlines, isolated from another account", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "queue.sqlite")
    const first = new Database(file)
    const queue = new ResearchQueue(first, "cloud-one/account-a")
    queue.enqueue(mutation(1))
    queue.defer({ failures: 3, nextAttempt: 9000 })
    first.close()
    const second = new Database(file)
    try {
      const same = new ResearchQueue(second, "cloud-one/account-a")
      const other = new ResearchQueue(second, "cloud-one/account-b")
      const otherCloud = new ResearchQueue(second, "cloud-two/account-a")
      expect(same.peek(10).map((x) => JSON.parse(x.json))).toEqual([mutation(1)])
      expect(same.retry()).toEqual({ failures: 3, nextAttempt: 9000 })
      expect(other.count).toBe(0)
      expect(otherCloud.count).toBe(0)
      other.enqueue(mutation(2))
      other.acknowledge(other.peek(10))
      expect(same.count).toBe(1)
    } finally {
      second.close()
    }
  })

  test("research projection failures preserve the local write and later uploads", async () => {
    await using dir = await tmpdir()
    const local = await connectLocalStore({ directory: dir.path, researchPartition: "account-a" })
    try {
      await local.db.collection("runs").insertOne({ _id: "run", value: "durable" })
      expect(local.researchQueue!.peek(10).map((x) => JSON.parse(x.json).document)).toEqual([
        { _id: "run", value: "durable" },
      ])
      await local.db.collection("artifacts").insertOne({ _id: "bad", kind: "transcript", data: "invalid" })
      expect(await local.db.collection("artifacts").findOne({ _id: "bad" })).toEqual({
        _id: "bad",
        kind: "transcript",
        data: Buffer.from("invalid"),
      })
      await local.db.collection("runs").insertOne({ _id: "later", value: "also durable" })
      expect(local.researchQueue!.peek(10).map((row) => JSON.parse(row.json).id)).toEqual(["run", "later"])
      expect(local.researchQueue!.rejected().map((row) => ({ id: row.id, reason: row.reason }))).toEqual([
        { id: "bad", reason: "projection_failed" },
      ])
    } finally {
      await local.close()
    }
  })

  test("upload queue storage failures leave committed local records and their raw revisions recoverable", async () => {
    await using dir = await tmpdir()
    const local = await connectLocalStore({ directory: dir.path, researchPartition: "account-a" })
    const sqlite = new Database(path.join(dir.path, "arena.sqlite"))
    const batches: ResearchRecord[][] = []
    const uploader = new ResearchUploader({
      url: "https://control.test",
      token: "test",
      sourceID: local.sourceID,
      queue: local.researchQueue!,
      intervalMs: 60_000,
      now: () => 10_000,
      warn: () => {},
      fetch: async (_url, init) => {
        const batch = requestBatch(init)
        batches.push(batch.records)
        return Response.json({ received: batch.records.length, stored: batch.records.length })
      },
    })
    try {
      sqlite.run(
        "CREATE TRIGGER reject_upload BEFORE INSERT ON arena_research_queue BEGIN SELECT RAISE(ABORT, 'upload queue unavailable'); END",
      )
      await local.db.collection("runs").insertOne({ _id: "run", state: "complete" })
      await uploader.flush()
      expect(await local.db.collection("runs").findOne({ _id: "run" })).toEqual({ _id: "run", state: "complete" })
      expect(local.researchQueue!.count).toBe(1)
      expect(batches).toEqual([])
      sqlite.run("DROP TRIGGER reject_upload")
      local.researchQueue!.defer({ failures: 0, nextAttempt: 0 })
      await uploader.flush()
      expect(batches.flat().map((record) => record.document)).toEqual([{ _id: "run", state: "complete" }])
      expect(local.researchQueue!.count).toBe(0)
    } finally {
      await uploader.close()
      sqlite.close()
      await local.close()
    }
  })

  test("more than 8 MiB remains queued and large Unicode documents round-trip through bounded chunks", async () => {
    await using f = fixture()
    const document = { _id: "large", text: "你好🌏".repeat(1_200_000) }
    f.queue.enqueue({ collection: "events", id: "large", revision: 1, document })
    expect(f.queue.bytes).toBeGreaterThan(8 * 1024 * 1024)
    const pending = f.queue.peek(100)
    expect(pending.every((x) => x.bytes <= MAX_RESEARCH_RECORD_BYTES)).toBe(true)
    while (f.queue.count) await f.uploader.flush()
    const uploaded = f.batches.flat()
    const chunks = new Map(uploaded.filter((x) => x.collection === "chunks").map((x) => [x.id, x.document]))
    const manifest = uploaded.at(-1)!
    expect(manifest.collection).toBe("events")
    expect(await resolveResearchDocument(manifest.document, async (id) => chunks.get(id) ?? null)).toEqual(document)
    await expect(
      resolveResearchDocument(manifest.document, async () => ({ data: "YQ==", dataEncoding: "base64" })),
    ).rejects.toThrow("checksum")
    await expect(resolveResearchDocument(manifest.document, async () => null)).rejects.toThrow()
    expect(
      f.batches.every(
        (records) =>
          Buffer.byteLength(JSON.stringify({ version: 1, sourceID: randomUUID(), records })) <=
          MAX_RESEARCH_BATCH_BYTES,
      ),
    ).toBe(true)
  })

  test("a transcript and image larger than the old 10 MiB limit remain complete locally and upload in chunks", async () => {
    await using dir = await tmpdir()
    const local = await connectLocalStore({ directory: dir.path, researchPartition: "account-a" })
    const uploaded = new Map<string, ResearchRecord>()
    const uploader = new ResearchUploader({
      queue: local.researchQueue!,
      url: "https://control.test",
      token: "test",
      sourceID: local.sourceID,
      intervalMs: 60000,
      warn: () => {},
      fetch: async (_url, init) => {
        const batch = requestBatch(init)
        for (const record of batch.records) uploaded.set(record.id, record)
        return Response.json({ received: batch.records.length, stored: batch.records.length })
      },
    })
    try {
      const archived = {
        text: randomBytes(11 * 1024 * 1024).toString("base64"),
        url: `data:image/png;base64,${randomBytes(11 * 1024 * 1024).toString("base64")}`,
      }
      const result = await ArenaTranscriptArtifact.write(local, { runID: "large", turnID: "turn", archived })
      expect(result.transcript.storedSize).toBeGreaterThan(10 * 1024 * 1024)
      expect(result.transcript.truncated).toBe(false)
      const value = ArenaTranscriptArtifact.decode(result.transcript)
      expect(await ArenaTranscriptArtifact.withImages(local, "large", value)).toEqual(archived)
      while (local.researchQueue!.count) await uploader.flush()
      const body = await resolveResearchDocument(
        uploaded.get("large|transcript")!.document,
        async (id) => uploaded.get(id)?.document ?? null,
      )
      expect(body?.data).toBe(result.transcript.data.toString("base64"))
      const image = [...uploaded.values()].find((x) => x.collection === "images")!
      const imageBody = await resolveResearchDocument(image.document, async (id) => uploaded.get(id)?.document ?? null)
      expect(imageBody?.data).toBe(archived.url.split(",")[1])
    } finally {
      await uploader.close()
      await local.close()
    }
  })

  test("reply resets preserve the last cloud archive until a replacement is uploaded", () => {
    expect(
      projectResearchRecords({ collection: "artifacts", id: "run|transcript", revision: 2, document: null }),
    ).toEqual([])
    expect(
      projectResearchRecords({ collection: "sessionArchives", id: "run|archive", revision: 3, document: null }),
    ).toEqual([])
    expect(projectResearchRecords({ collection: "runs", id: "run", revision: 4, document: null })).toEqual([
      { collection: "runs", id: "run", revision: 4, document: null },
    ])
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
})
