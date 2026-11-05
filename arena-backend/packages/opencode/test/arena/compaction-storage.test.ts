import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import type { CompactionObservation } from "@/arena/compaction-metrics"
import type { BattleMetricsDocument, GenerationDocument, RunDocument, UsageTotals } from "@/arena/records"

function usage(values: Partial<UsageTotals> = {}): UsageTotals {
  return {
    promptTokens: 1,
    completionTokens: 1,
    reasoningTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0.01,
    attempts: 1,
    latencyMs: 1,
    provenance: "provider",
    version: 2,
    ...values,
  }
}

function run(_id: string, turnID = "turn", side: "a" | "b" = "a") {
  return { _id, turnID, side } as RunDocument
}

function metrics(turnID: string): BattleMetricsDocument {
  return {
    _id: turnID,
    schemaVersion: 1,
    computedAt: new Date(1),
    turnID,
    chatID: `chat-${turnID}`,
    turnIndex: 0,
    modelPair: [],
    selectedEarly: false,
    steerCount: 0,
    sides: {},
  }
}

function generation(_id: string, runID: string, compactionID: string, callUsage?: UsageTotals) {
  return {
    _id,
    runID,
    rootSessionID: "root",
    sessionID: "session",
    callIndex: 0,
    requestID: `request-${_id}`,
    assignmentID: "assignment",
    requestedModel: "model",
    requestedReasoning: {},
    enforcedReasoning: {},
    classification: "compaction",
    requestKind: "compaction",
    opportunisticCompactionID: compactionID,
    startedAt: new Date(1),
    ...(callUsage === undefined ? {} : { usage: callUsage }),
  } as GenerationDocument
}

function observation(id: string, runID: string, status: CompactionObservation["status"], finishedAt?: number) {
  return {
    id,
    runID,
    sourceSessionID: `session-${runID}`,
    sourceVersion: "version",
    status,
    createdAt: 1,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    cancellationFailed: false,
    perceivedWaitMs: 0,
  } satisfies CompactionObservation
}

async function directory() {
  return mkdtemp(path.join(os.tmpdir(), "arena-compaction-storage-"))
}

describe("Arena compaction storage", () => {
  test("known to missing to known never recreates nullable totals", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      try {
        await store.runs.insertOne(run("run"))
        await store.accumulateRunUsage(
          "run",
          usage({ completionTokens: 4, reasoningTokens: 2, totalTokens: 6, cost: 0.2, upstreamInferenceCost: 0.1 }),
        )
        await store.accumulateRunUsage(
          "run",
          usage({
            promptTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            cost: null,
            upstreamInferenceCost: undefined,
          }),
        )
        await store.accumulateRunUsage(
          "run",
          usage({ completionTokens: 8, reasoningTokens: 3, totalTokens: 11, cost: 0.4, upstreamInferenceCost: 0.2 }),
        )
        const saved = await store.runs.findOne({ _id: "run" })
        expect(saved?.usage).toMatchObject({ attempts: 3, latencyMs: 3 })
        expect(saved?.usage?.promptTokens).toBeUndefined()
        expect(saved?.usage?.cacheReadTokens).toBeUndefined()
        expect(saved?.usage?.cacheWriteTokens).toBeUndefined()
        expect(saved?.usage?.completionTokens).toBeUndefined()
        expect(saved?.usage?.reasoningTokens).toBeUndefined()
        expect(saved?.usage?.totalTokens).toBeUndefined()
        expect(saved?.usage?.cost).toBeUndefined()
        expect(saved?.usage?.upstreamInferenceCost).toBeUndefined()
      } finally {
        await store.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test("missing to known preserves unknown nullable totals", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      try {
        await store.runs.insertOne(run("run"))
        await store.accumulateRunUsage(
          "run",
          usage({
            promptTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            cost: null,
            upstreamInferenceCost: undefined,
          }),
        )
        await store.accumulateRunUsage(
          "run",
          usage({ completionTokens: 8, reasoningTokens: 3, totalTokens: 11, cost: 0.4, upstreamInferenceCost: 0.2 }),
        )
        const saved = await store.runs.findOne({ _id: "run" })
        expect(saved?.usage?.promptTokens).toBeUndefined()
        expect(saved?.usage?.cacheReadTokens).toBeUndefined()
        expect(saved?.usage?.cacheWriteTokens).toBeUndefined()
        expect(saved?.usage?.completionTokens).toBeUndefined()
        expect(saved?.usage?.reasoningTokens).toBeUndefined()
        expect(saved?.usage?.totalTokens).toBeUndefined()
        expect(saved?.usage?.cost).toBeUndefined()
        expect(saved?.usage?.upstreamInferenceCost).toBeUndefined()
      } finally {
        await store.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test("explicit null telemetry stays unknown when a later call is known", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      try {
        await store.runs.insertOne({
          ...run("run"),
          usage: usage({
            promptTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            cost: null,
            upstreamInferenceCost: undefined,
          }),
        } as RunDocument)
        await store.accumulateRunUsage(
          "run",
          usage({
            promptTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            completionTokens: 5,
            reasoningTokens: 6,
            totalTokens: 7,
            cost: 0.07,
            upstreamInferenceCost: 0.2,
          }),
        )
        const saved = await store.runs.findOne({ _id: "run" })
        expect(saved?.usage?.promptTokens).toBeNull()
        expect(saved?.usage?.cacheReadTokens).toBeNull()
        expect(saved?.usage?.cacheWriteTokens).toBeNull()
        expect(saved?.usage?.completionTokens).toBeNull()
        expect(saved?.usage?.reasoningTokens).toBeNull()
        expect(saved?.usage?.totalTokens).toBeNull()
        expect(saved?.usage?.cost).toBeNull()
        expect(saved?.usage?.upstreamInferenceCost).toBeUndefined()
      } finally {
        await store.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test("late cost reports refresh post-vote compaction metrics", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      try {
        await store.runs.insertOne(run("run"))
        await store.battleMetrics.insertOne(metrics("turn"))
        await store.generations.insertOne(generation("generation", "run", "compact"))
        await store.recordCompaction(observation("compact", "run", "discarded", 4))
        expect((await store.battleMetrics.findOne({ _id: "turn" }))?.sides.a?.compactions?.wastedTokens).toBeNull()
        await store.updateGeneration("generation", {
          usage: usage({ totalTokens: 13, completionTokens: 10, reasoningTokens: 3, cost: 0.13 }),
        })
        expect((await store.battleMetrics.findOne({ _id: "turn" }))?.sides.a?.compactions).toMatchObject({
          wastedTokens: 13,
          wastedCost: 0.13,
        })
      } finally {
        await store.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test("pending compactions survive reopen and are recovered", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      await store.runs.insertOne(run("run"))
      await store.recordCompaction(observation("pending", "run", "pending"))
      expect((await store.runs.findOne({ _id: "run" }))?.pendingCompactionIDs).toEqual(["pending"])
      await store.close()

      const reopened = await connectLocalStore({ directory: data })
      try {
        expect((await reopened.runs.findOne({ _id: "run" }))?.pendingCompactionIDs).toEqual(["pending"])
        await reopened.recoverCompactions()
        const recovered = await reopened.runs.findOne({ _id: "run" })
        expect(recovered?.pendingCompactionIDs ?? []).toHaveLength(0)
        expect(recovered?.compactions?.pending.status).toBe("discarded")
        expect(recovered?.compactions?.pending.finishedAt).toBeNumber()
      } finally {
        await reopened.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test("compaction metrics isolate runs even when IDs collide", async () => {
    const data = await directory()
    try {
      const store = await connectLocalStore({ directory: data })
      try {
        await store.runs.insertOne(run("run-a", "turn-a", "a"))
        await store.runs.insertOne(run("run-b", "turn-b", "b"))
        await store.battleMetrics.insertOne(metrics("turn-a"))
        await store.battleMetrics.insertOne(metrics("turn-b"))
        await store.generations.insertOne(
          generation("generation-a", "run-a", "shared", usage({ totalTokens: 4, completionTokens: 3, cost: 0.04 })),
        )
        await store.generations.insertOne(
          generation("generation-b", "run-b", "shared", usage({ totalTokens: 9, completionTokens: 8, cost: 0.09 })),
        )
        await store.recordCompaction(observation("shared", "run-a", "discarded", 4))
        await store.recordCompaction(observation("shared", "run-b", "discarded", 4))
        expect((await store.battleMetrics.findOne({ _id: "turn-a" }))?.sides.a?.compactions?.wastedTokens).toBe(4)
        expect((await store.battleMetrics.findOne({ _id: "turn-b" }))?.sides.b?.compactions?.wastedTokens).toBe(9)
      } finally {
        await store.close()
      }
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })
})
