import { describe, expect, test } from "bun:test"
import type { GenerationDocument, UsageTotals } from "../../src/arena/records"
import type { CompactionObservation } from "../../src/arena/compaction-metrics"
import { compactionMetrics } from "../../src/arena/compaction-metrics"

function observation(id: string, status: CompactionObservation["status"], extra: Partial<CompactionObservation> = {}) {
  return {
    id,
    runID: "run",
    sourceSessionID: `session-${id}`,
    sourceVersion: "version-1",
    status,
    createdAt: 1,
    cancellationFailed: false,
    perceivedWaitMs: 0,
    ...extra,
  } satisfies CompactionObservation
}

function usage(totalTokens: number, cost: number, reasoningTokens = 0): UsageTotals {
  return {
    promptTokens: 10,
    completionTokens: totalTokens,
    reasoningTokens,
    totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost,
    attempts: 1,
    latencyMs: 1,
    provenance: "provider",
    version: 2,
  }
}

function generation(id: string, compactionID: string, callUsage?: UsageTotals): GenerationDocument {
  return {
    _id: id,
    runID: "run",
    rootSessionID: "root",
    sessionID: "session",
    callIndex: 0,
    requestID: `request-${id}`,
    assignmentID: "assignment",
    requestedModel: "model",
    requestedReasoning: {},
    enforcedReasoning: {},
    classification: "compaction",
    requestKind: "compaction",
    opportunisticCompactionID: compactionID,
    startedAt: new Date(1),
    completedAt: new Date(2),
    ...(callUsage === undefined ? {} : { usage: callUsage }),
  }
}

describe("compactionMetrics", () => {
  test("counts used, canceled, failed, discarded and cancellation failures separately", () => {
    const metrics = compactionMetrics(
      {
        used: observation("used", "used"),
        canceled: observation("canceled", "canceled", { canceledAt: 2, finishedAt: 3 }),
        failed: observation("failed", "failed", { finishedAt: 4 }),
        discarded: observation("discarded", "discarded", { finishedAt: 5, cancellationFailed: true }),
      },
      [],
    )
    expect(metrics).toMatchObject({ started: 4, used: 1, canceled: 1, failed: 1, discarded: 1, cancellationFailed: 1 })
  })

  test("counts a canceled late result as both canceled and discarded", () => {
    const metrics = compactionMetrics({ late: observation("late", "discarded", { canceledAt: 2, finishedAt: 3 }) }, [
      generation("late-generation", "late", usage(4, 0.01)),
    ])
    expect(metrics).toMatchObject({ started: 1, canceled: 1, discarded: 1, wastedTokens: 4, wastedCost: 0.01 })
  })

  test("keeps wasted token and cost totals unknown when any counted call lacks usage", () => {
    const metrics = compactionMetrics(
      {
        failed: observation("failed", "failed", { finishedAt: 3 }),
        missing: observation("missing", "discarded", { finishedAt: 4 }),
      },
      [generation("known-usage", "failed", usage(7, 0.07))],
    )
    expect(metrics.wastedTokens).toBeNull()
    expect(metrics.wastedCost).toBeNull()
  })

  test("preserves provider-confirmed zero usage as zero", () => {
    const metrics = compactionMetrics({ failed: observation("failed", "failed", { finishedAt: 3 }) }, [
      generation("zero-usage", "failed", usage(0, 0, 0)),
    ])
    expect(metrics.wastedTokens).toBe(0)
    expect(metrics.wastedCost).toBe(0)
  })

  test("isolates waste by proactive compaction ID across contestants and generations", () => {
    const metrics = compactionMetrics(
      {
        left: observation("left", "discarded", { finishedAt: 3 }),
        right: observation("right", "used"),
      },
      [generation("left-generation", "left", usage(5, 0.05)), generation("right-generation", "right", usage(9, 0.09))],
    )
    expect(metrics.wastedTokens).toBe(5)
    expect(metrics.wastedCost).toBe(0.05)
  })

  test("includes reasoning in the provider total exactly once", () => {
    const metrics = compactionMetrics({ failed: observation("failed", "failed", { finishedAt: 3 }) }, [
      generation("reasoning-generation", "failed", usage(17, 0.17, 8)),
    ])
    expect(metrics.wastedTokens).toBe(17)
    expect(metrics.wastedTokens).not.toBe(25)
  })
})
