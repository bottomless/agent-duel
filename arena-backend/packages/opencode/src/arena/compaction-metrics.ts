import type { CompactionStatus, CompactionSnapshot } from "./opportunistic-compaction"
import type { GenerationDocument } from "./records"

export interface CompactionObservation {
  readonly id: string
  readonly runID: string
  readonly sourceSessionID: string
  readonly sourceVersion: string
  readonly status: CompactionStatus
  readonly createdAt: number
  readonly finishedAt?: number
  readonly canceledAt?: number
  readonly cancellationFailed: boolean
  /** Time actually waiting for proactive inference or cancellation acknowledgement. */
  readonly perceivedWaitMs: number
  readonly selectionMs?: number
}

export function compactionObservation(id: string, snapshot: CompactionSnapshot): CompactionObservation {
  return {
    id,
    runID: snapshot.runID,
    sourceSessionID: snapshot.sourceSessionID,
    sourceVersion: String(snapshot.sourceVersion),
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    finishedAt: snapshot.finishedAt,
    canceledAt: snapshot.canceledAt,
    cancellationFailed: snapshot.cancellationFailed,
    perceivedWaitMs: snapshot.perceivedWaitMs,
  }
}

export interface CompactionMetrics {
  readonly started: number
  readonly used: number
  readonly canceled: number
  readonly failed: number
  readonly discarded: number
  readonly cancellationFailed: number
  readonly wastedTokens: number | null
  readonly wastedCost: number | null
  readonly perceivedWaitMs: number
}

export function compactionMetrics(
  observations: Readonly<Record<string, CompactionObservation>>,
  generations: readonly GenerationDocument[],
): CompactionMetrics {
  const entries = Object.values(observations)
  const waste = entries.filter((entry) => ["canceled", "failed", "discarded"].includes(entry.status))
  const wasteIDs = new Set(waste.map((entry) => entry.id))
  const matching = generations.filter((generation) => {
    const id = generation.opportunisticCompactionID
    return id !== undefined && wasteIDs.has(id) && observations[id]?.runID === generation.runID
  })
  const calls = [...new Map(matching.map((call) => [call._id, call])).values()]
  const covered = waste.every((entry) => calls.some((call) => call.opportunisticCompactionID === entry.id))
  // A canceled stream may have spent tokens without a final usage packet. Missing cost stays unknown.
  const verified = calls.every((call) => call.usage?.provenance === "provider" && call.usage.version === 2)
  const tokensKnown = covered && verified && calls.every((call) => call.usage?.totalTokens != null)
  const costsKnown = covered && verified && calls.every((call) => call.usage?.cost != null)
  const settled = waste.every((entry) => entry.finishedAt !== undefined)
  return {
    started: entries.length,
    used: entries.filter((entry) => entry.status === "used").length,
    canceled: entries.filter((entry) => entry.canceledAt !== undefined).length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    discarded: entries.filter((entry) => entry.status === "discarded").length,
    cancellationFailed: entries.filter((entry) => entry.cancellationFailed).length,
    wastedTokens: settled && tokensKnown ? calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0) : null,
    wastedCost: settled && costsKnown ? calls.reduce((sum, call) => sum + (call.usage?.cost ?? 0), 0) : null,
    perceivedWaitMs: entries.reduce((sum, entry) => sum + entry.perceivedWaitMs, 0),
  }
}
