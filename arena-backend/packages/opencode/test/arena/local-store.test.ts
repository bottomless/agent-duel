import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import { MAX_RUN_ARTIFACT_BYTES } from "@/arena/artifact"
import { ArenaTranscriptArtifact } from "@/arena/transcript-artifact"
import type { ArenaRecord } from "@agent-duel/arena-service/collection"
import type { ChatDocument, GenerationDocument } from "@/arena/records"

const now = new Date("2026-01-01T00:00:00.000Z")

function chat(_id: string): ChatDocument {
  return {
    _id,
    repository: { projectID: "project", root: "/repo", branch: "main" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: "canonical",
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "ready",
    opencodeCommit: "commit",
    opencodeVersion: "version",
    arenaVersion: "arena",
    configuration: {
      modelPool: "model-pool",
      agent: "agent",
      plugins: "plugins",
      mcp: "mcp",
      skills: "skills",
      tools: "tools",
      system: "system",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
}

function generation(_id: string, callIndex: number, providerGenerationID?: string): GenerationDocument {
  return {
    _id,
    runID: "run",
    rootSessionID: "root-session",
    sessionID: "session",
    callIndex,
    requestID: `request-${callIndex}`,
    ...(providerGenerationID ? { providerGenerationID } : {}),
    requestedAlias: "arena-01",
    requestedTransportSlug: "hidden/model",
    canonicalSlug: "hidden/model",
    resolvedProvider: "provider",
    requestedReasoning: { effort: "high" },
    enforcedReasoning: { effort: "high" },
    classification: "root",
    startedAt: now,
  }
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "arena-local-store-"))
}

describe("local Arena store", () => {
  test("competing independent handles allow one compare-and-swap update", async () => {
    const directory = await temporaryDirectory()
    try {
      const [left, right] = await Promise.all([connectLocalStore({ directory }), connectLocalStore({ directory })])
      await left.chats.insertOne(chat("chat"))
      const [first, second] = await Promise.all([
        left.chats.findOneAndUpdate(
          { _id: "chat", status: "ready" },
          { $set: { status: "battle_active" } },
          { returnDocument: "after" },
        ),
        right.chats.findOneAndUpdate(
          { _id: "chat", status: "ready" },
          { $set: { status: "battle_active" } },
          { returnDocument: "after" },
        ),
      ])
      expect([first, second].filter((value) => value !== null)).toHaveLength(1)
      expect([first, second].filter((value) => value === null)).toHaveLength(1)
      expect((await left.chats.findOne({ _id: "chat" }))?.status).toBe("battle_active")
      await Promise.all([left.close(), right.close()])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps source identity and mutation revisions across handles and reopen", async () => {
    const directory = await temporaryDirectory()
    const revisions: number[] = []
    try {
      const first = await connectLocalStore({ directory, onMutation: (mutation) => revisions.push(mutation.revision) })
      const second = await connectLocalStore({ directory, onMutation: (mutation) => revisions.push(mutation.revision) })
      expect(second.sourceID).toBe(first.sourceID)
      await first.chats.insertOne(chat("chat"))
      expect(await first.chats.findOne({ _id: "chat" }, { projection: { _id: 1, activeTurnID: 1 } })).toEqual({
        _id: "chat",
      })
      await second.chats.updateOne({ _id: "chat" }, { $set: { status: "battle_active" } })
      await Promise.all([first.close(), second.close()])
      expect(revisions.toSorted()).toEqual([1, 2])

      const reopened = await connectLocalStore({
        directory,
        onMutation: (mutation) => revisions.push(mutation.revision),
      })
      expect(reopened.sourceID).toBe(first.sourceID)
      await reopened.chats.updateOne({ _id: "chat" }, { $set: { status: "ready" } })
      expect(revisions.at(-1)).toBe(3)
      await reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("delivers only committed mutations and keeps rolled-back multiupdates invisible", async () => {
    const directory = await temporaryDirectory()
    const mutations: number[] = []
    const observations: Promise<void>[] = []
    try {
      const observer = await connectLocalStore({ directory })
      const writer = await connectLocalStore({
        directory,
        onMutation: (mutation) => {
          mutations.push(mutation.revision)
          observations.push(
            observer.db
              .collection<ArenaRecord>(mutation.collection)
              .findOne({ _id: mutation.id })
              .then((document) => expect(document).toEqual(mutation.document)),
          )
        },
      })
      await writer.chats.insertOne(chat("chat"))
      await writer.generations.insertOne(generation("generation-a", 0))
      await writer.generations.insertOne(generation("generation-b", 1))
      await Promise.all(observations)
      expect(mutations).toEqual([1, 2, 3])

      await expect(
        writer.generations.updateMany({ runID: "run" }, { $set: { providerGenerationID: "same-provider" } }),
      ).rejects.toThrow()
      expect(mutations).toEqual([1, 2, 3])
      expect(await writer.generations.find({ runID: "run" }).toArray()).toEqual([
        generation("generation-a", 0),
        generation("generation-b", 1),
      ])
      await Promise.all([writer.close(), observer.close()])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("enforces initialized partial uniqueness for provider generation IDs", async () => {
    const directory = await temporaryDirectory()
    try {
      const store = await connectLocalStore({ directory })
      await store.generations.insertOne(generation("generation-a", 0, "provider-generation"))
      await expect(store.generations.insertOne(generation("generation-b", 1, "provider-generation"))).rejects.toThrow()
      await store.generations.insertOne(generation("generation-c", 2))
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists pushed run outcomes with dates", async () => {
    const directory = await temporaryDirectory()
    try {
      type OutcomeRecord = { readonly _id: string; readonly outcomes: ReadonlyArray<Readonly<Record<string, unknown>>> }
      const store = await connectLocalStore({ directory })
      const runs = store.db.collection<OutcomeRecord>("runs")
      await runs.insertOne({ _id: "run", outcomes: [] })
      await runs.updateOne({ _id: "run" }, { $push: { outcomes: { kind: "permission", at: now } } })
      expect(await runs.findOne({ _id: "run" })).toEqual({
        _id: "run",
        outcomes: [{ kind: "permission", at: now }],
      })
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("renames persisted fields during store initialization", async () => {
    const directory = await temporaryDirectory()
    try {
      type LegacyRun = { readonly _id: string; readonly terminal?: string; readonly runState?: string }
      const store = await connectLocalStore({ directory })
      const runs = store.db.collection<LegacyRun>("runs")
      await runs.insertOne({ _id: "run", terminal: "complete" })
      await runs.updateMany({ terminal: { $exists: true } }, { $rename: { terminal: "runState" } })
      expect(await runs.findOne({ _id: "run" })).toEqual({ _id: "run", runState: "complete" })
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("scrubs legacy telemetry for unresolved battles on startup", async () => {
    const directory = await temporaryDirectory()
    try {
      let store = await connectLocalStore({ directory })
      const turns = store.db.collection<ArenaRecord>("turns")
      const runs = store.db.collection<ArenaRecord>("runs")
      const generations = store.db.collection<ArenaRecord>("generations")
      const metrics = store.db.collection<ArenaRecord>("battleMetrics")
      await turns.insertOne({ _id: "turn-unresolved", state: "awaiting_vote" })
      await runs.insertOne({
        _id: "run-unresolved",
        turnID: "turn-unresolved",
        usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 10 },
      })
      await generations.insertOne({
        _id: "generation-unresolved",
        runID: "run-unresolved",
        usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 10 },
        finishReason: "end_turn",
        providerGenerationID: "provider-generation",
        requestArtifactID: "generation-unresolved|request",
        responseArtifactID: "generation-unresolved|response",
        payloadHashes: { request: "request", response: "response" },
        routing: { headers: { "x-openrouter-provider": "hidden", "content-type": "application/json" } },
      })
      await metrics.insertOne({ _id: "turn-unresolved", promptTokens: 100 })
      const response = Buffer.from(
        '{"native_finish_reason":"end_turn","usage":{"prompt_tokens":100},"format":"anthropic-claude-v1"}',
      )
      const request = Buffer.from('{"reasoning_details":[{"format":"xai-responses-v1"}]}')
      await store.storeArtifact({
        _id: "generation-unresolved|request",
        runID: "run-unresolved",
        kind: "generation_request",
        mimeType: "application/json",
        encoding: "utf8",
        compression: "none",
        data: request,
        createdAt: now,
      })
      await store.storeArtifact({
        _id: "generation-unresolved|response",
        runID: "run-unresolved",
        kind: "generation_response",
        mimeType: "application/json",
        encoding: "utf8",
        compression: "none",
        data: response,
        createdAt: now,
      })
      const artifactPath = path.join(
        directory,
        "artifacts",
        "sha256",
        createHash("sha256").update(response).digest("hex"),
      )
      const requestArtifactPath = path.join(
        directory,
        "artifacts",
        "sha256",
        createHash("sha256").update(request).digest("hex"),
      )
      await store.close()

      const database = new Database(path.join(directory, "arena.sqlite"))
      database
        .query("DELETE FROM arena_metadata WHERE key = 'privacy.blinded-generation-telemetry'")
        .run()
      database.close()

      store = await connectLocalStore({ directory })
      const scrubbedRun = await store.db.collection<ArenaRecord>("runs").findOne({ _id: "run-unresolved" })
      const scrubbedGeneration = await store.db
        .collection<ArenaRecord>("generations")
        .findOne({ _id: "generation-unresolved" })
      expect(scrubbedRun).not.toHaveProperty("usage")
      expect(scrubbedGeneration).not.toHaveProperty("usage")
      expect(scrubbedGeneration).not.toHaveProperty("finishReason")
      expect(scrubbedGeneration).not.toHaveProperty("providerGenerationID")
      expect(scrubbedGeneration).not.toHaveProperty("requestArtifactID")
      expect(scrubbedGeneration).not.toHaveProperty("responseArtifactID")
      expect(scrubbedGeneration).not.toHaveProperty("payloadHashes")
      expect(scrubbedGeneration?.routing).toEqual({ headers: { "content-type": "application/json" } })
      expect(await store.artifacts.findOne({ _id: "generation-unresolved|request" })).toBeNull()
      expect(await store.artifacts.findOne({ _id: "generation-unresolved|response" })).toBeNull()
      expect(await store.db.collection<ArenaRecord>("battleMetrics").findOne({ _id: "turn-unresolved" })).toBeNull()
      await expect(access(artifactPath)).rejects.toThrow()
      await expect(access(requestArtifactPath)).rejects.toThrow()
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("opens while a scrubbed telemetry file cannot be deleted, and deletes it at a later start", async () => {
    const directory = await temporaryDirectory()
    const root = path.join(directory, "artifacts", "sha256")
    try {
      const store = await connectLocalStore({ directory })
      await store.db.collection<ArenaRecord>("turns").insertOne({ _id: "turn", state: "awaiting_vote" })
      await store.db.collection<ArenaRecord>("runs").insertOne({ _id: "run", turnID: "turn" })
      await store.db
        .collection<ArenaRecord>("generations")
        .insertOne({ _id: "generation", runID: "run", responseArtifactID: "generation|response" })
      const response = Buffer.from('{"format":"anthropic-claude-v1"}')
      await store.storeArtifact({
        _id: "generation|response",
        runID: "run",
        kind: "generation_response",
        mimeType: "application/json",
        encoding: "utf8",
        compression: "none",
        data: response,
        createdAt: now,
      })
      await store.close()
      const database = new Database(path.join(directory, "arena.sqlite"))
      database.query("DELETE FROM arena_metadata WHERE key = 'privacy.blinded-generation-telemetry'").run()
      database.close()
      const file = createHash("sha256").update(response).digest("hex")
      // A directory nobody may write to refuses the delete, as a locked file does.
      await chmod(root, 0o555)

      const reopened = await connectLocalStore({ directory })
      expect(await reopened.artifacts.findOne({ _id: "generation|response" })).toBeNull()
      await reopened.close()
      expect(await readdir(root)).toEqual([file])

      await chmod(root, 0o755)
      await (await connectLocalStore({ directory })).close()
      expect(await readdir(root)).toEqual([])
    } finally {
      await chmod(root, 0o755).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("does not hydrate artifact bytes for metadata projections", async () => {
    const directory = await temporaryDirectory()
    try {
      const store = await connectLocalStore({ directory })
      const data = Buffer.from("arena artifact")
      await store.storeArtifact({
        _id: "artifact",
        runID: "run",
        kind: "other",
        mimeType: "text/plain",
        encoding: "binary",
        compression: "none",
        data,
        createdAt: now,
      })
      const hash = createHash("sha256").update(data).digest("hex")
      await unlink(path.join(directory, "artifacts", "sha256", hash))
      expect(await store.artifacts.findOne({ _id: "artifact" }, { projection: { _id: 1, storedSize: 1 } })).toEqual({
        _id: "artifact",
        storedSize: data.byteLength,
      })
      const database = new Database(path.join(directory, "arena.sqlite"), { readonly: true })
      const row = database
        .query<
          { document: string },
          [string, string]
        >("SELECT document FROM arena_documents WHERE collection = ? AND id = ?")
        .get("artifacts", "artifact")
      expect(row?.document.includes('"data"')).toBe(false)
      database.close()
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  test("reclaims artifact files no record names on the next start", async () => {
    const directory = await temporaryDirectory()
    try {
      const store = await connectLocalStore({ directory })
      const artifact = (_id: string, text: string) =>
        store.storeArtifact({
          _id,
          runID: "run",
          kind: "other",
          mimeType: "text/plain",
          encoding: "binary",
          compression: "none",
          data: Buffer.from(text),
          createdAt: now,
        })
      await artifact("kept", "shared bytes")
      await artifact("deleted-shared", "shared bytes")
      await artifact("deleted", "only this record")
      await store.artifacts.deleteMany({ _id: { $in: ["deleted-shared", "deleted"] } })
      await store.close()

      const root = path.join(directory, "artifacts", "sha256")
      const hash = (text: string) => createHash("sha256").update(text).digest("hex")
      const fresh = path.join(root, "fresh-orphan")
      await writeFile(fresh, "written by another handle a moment ago")
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      for (const name of [hash("shared bytes"), hash("only this record")]) {
        await utimes(path.join(root, name), hourAgo, hourAgo)
      }

      const reopened = await connectLocalStore({ directory })
      expect((await readdir(root)).sort()).toEqual([hash("shared bytes"), "fresh-orphan"].sort())
      expect((await reopened.artifacts.findOne({ _id: "kept" }))?.data.toString()).toBe("shared bytes")
      await reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps a long run's transcript whole after its other artifacts used the run budget", async () => {
    const directory = await temporaryDirectory()
    try {
      const store = await connectLocalStore({ directory })
      await store.storeArtifact({
        _id: "requests",
        runID: "run",
        kind: "generation_request",
        mimeType: "application/json",
        encoding: "binary",
        compression: "none",
        data: Buffer.alloc(MAX_RUN_ARTIFACT_BYTES - 10),
        createdAt: now,
      })
      const transcript = [{ sessionID: "root", messages: [{ text: "x".repeat(10_000) }] }]
      const encoded = ArenaTranscriptArtifact.encode(transcript)
      const stored = await store.storeArtifact({
        _id: "run|transcript",
        runID: "run",
        kind: "transcript",
        mimeType: "application/json",
        encoding: "json",
        compression: encoded.compression,
        data: encoded.data,
        createdAt: now,
      })
      expect(stored.truncated).toBe(false)
      expect(ArenaTranscriptArtifact.decode((await store.artifacts.findOne({ _id: "run|transcript" }))!)).toEqual(
        transcript,
      )
      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("looks for unshared artifact files only after records were deleted", async () => {
    const directory = await temporaryDirectory()
    try {
      const root = path.join(directory, "artifacts", "sha256")
      const store = await connectLocalStore({ directory })
      await store.close()
      // A file no record names, but no record was deleted since the last pass: it stays.
      const stray = path.join(root, "stray")
      await mkdir(root, { recursive: true })
      await writeFile(stray, "left by something else")
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      await utimes(stray, hourAgo, hourAgo)
      await (await connectLocalStore({ directory })).close()
      expect(await readdir(root)).toEqual(["stray"])

      // Deleting a record asks the next start to look again.
      const writer = await connectLocalStore({ directory })
      await writer.storeArtifact({
        _id: "gone",
        runID: "run",
        kind: "other",
        mimeType: "text/plain",
        encoding: "binary",
        compression: "none",
        data: Buffer.from("gone"),
        createdAt: now,
      })
      await writer.artifacts.deleteOne({ _id: "gone" })
      await writer.close()
      const gone = path.join(root, createHash("sha256").update("gone").digest("hex"))
      await utimes(gone, hourAgo, hourAgo)
      await (await connectLocalStore({ directory })).close()
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("opens with an artifact file it cannot delete, and deletes it at a later start", async () => {
    const directory = await temporaryDirectory()
    const root = path.join(directory, "artifacts", "sha256")
    try {
      const writer = await connectLocalStore({ directory })
      await writer.storeArtifact({
        _id: "gone",
        runID: "run",
        kind: "other",
        mimeType: "text/plain",
        encoding: "binary",
        compression: "none",
        data: Buffer.from("locked"),
        createdAt: now,
      })
      await writer.artifacts.deleteOne({ _id: "gone" })
      await writer.close()
      const locked = createHash("sha256").update("locked").digest("hex")
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      await utimes(path.join(root, locked), hourAgo, hourAgo)
      // A directory nobody may write to refuses the delete, as a locked file does.
      await chmod(root, 0o555)

      await (await connectLocalStore({ directory })).close()
      expect(await readdir(root)).toEqual([locked])

      await chmod(root, 0o755)
      await (await connectLocalStore({ directory })).close()
      expect(await readdir(root)).toEqual([])
    } finally {
      await chmod(root, 0o755).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
