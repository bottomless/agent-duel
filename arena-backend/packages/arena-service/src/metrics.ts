export type UsageTotals = {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cost: number
  /** OpenRouter's provider inference charge, separate from the account charge above. */
  readonly upstreamInferenceCost?: number
  readonly attempts: number
  readonly latencyMs: number
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
