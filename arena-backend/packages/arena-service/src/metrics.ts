export type UsageTotals = {
  readonly promptTokens: number | null
  /** Provider-reported generated tokens, including reasoning tokens. */
  readonly completionTokens: number | null
  readonly reasoningTokens: number | null
  readonly totalTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly cost: number | null
  /** OpenRouter's provider inference charge, separate from the account charge above. */
  readonly upstreamInferenceCost?: number
  readonly attempts: number
  readonly latencyMs: number
  /** Present only on usage parsed by the current provider telemetry. */
  readonly provenance?: "provider"
  /** Usage wire-format version. Historical rows do not have this field. */
  readonly version?: 2
}

export const usageTotalsVersion = 2 as const

function addNullable(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right
}

/** Add finalized calls while preserving unknown provider fields. */
export function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const upstreamInferenceCost =
    left.attempts === 0
      ? right.upstreamInferenceCost
      : left.upstreamInferenceCost === undefined || right.upstreamInferenceCost === undefined
        ? undefined
        : left.upstreamInferenceCost + right.upstreamInferenceCost
  return {
    promptTokens: addNullable(left.promptTokens, right.promptTokens),
    completionTokens: addNullable(left.completionTokens, right.completionTokens),
    reasoningTokens: addNullable(left.reasoningTokens, right.reasoningTokens),
    totalTokens: addNullable(left.totalTokens, right.totalTokens),
    cacheReadTokens: addNullable(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: addNullable(left.cacheWriteTokens, right.cacheWriteTokens),
    cost: left.cost === null || right.cost === null ? null : left.cost + right.cost,
    ...(upstreamInferenceCost === undefined ? {} : { upstreamInferenceCost }),
    attempts: left.attempts + right.attempts,
    latencyMs: left.latencyMs + right.latencyMs,
    ...(left.provenance === "provider" && right.provenance === "provider" ? { provenance: "provider" as const } : {}),
    ...(left.version === usageTotalsVersion && right.version === usageTotalsVersion
      ? { version: usageTotalsVersion }
      : {}),
  }
}

export type GenerationMetrics = {
  readonly generationID: string
  readonly usage?: UsageTotals
  readonly finishReason?: string
}

/**
 * What the control plane stores for a call. The provider that served it stays here: no response or
 * reveal returns it, and the engine shares `GenerationMetrics`, which has no field to hold it.
 */
export type StoredGenerationMetrics = GenerationMetrics & {
  readonly provider?: string
}
