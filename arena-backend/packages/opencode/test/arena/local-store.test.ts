import { createHash } from "node:crypto"
import { access, mkdtemp, rm, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
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
})
