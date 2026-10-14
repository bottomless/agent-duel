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
