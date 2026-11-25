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

/** How a contestant call ended. A row written before this field existed is `complete`. */
export type GenerationOutcome = "complete" | "cancelled" | "failed" | "error"

/**
 * What the control plane stores for a call. The provider that served it stays here: no response or
 * reveal returns it, and the engine shares `GenerationMetrics`, which has no field to hold it.
 */
export type StoredGenerationMetrics = GenerationMetrics &
  Partial<EndpointLabel> & {
    readonly provider?: string
    readonly startedAt?: Date
    /** How the call ended; absent only on rows written before outcomes existed. */
    readonly outcome?: GenerationOutcome
    /** OpenRouter's own id for the call, when the stream showed it. */
    readonly upstreamGenerationID?: string
    /** OpenRouter's HTTP status when it refused the call. */
    readonly status?: number
    /** Silence since the last upstream data event when a stream ended early. */
    readonly quietMs?: number
  }

/** What the endpoint catalog says about the provider that served a call (`endpoint-label.ts`). */
export type EndpointLabel = {
  /**
   * The catalog's label, including its own "unknown". "ambiguous" means the provider's endpoints
   * disagree, and "unresolved" means no catalog entry could be matched.
   */
  readonly quantization: string
  readonly quantizationCandidates?: ReadonlyArray<string>
  /** Why the policy stored on the assignment let this endpoint serve the model. */
  readonly admittedBy: "first-party" | "trusted-host" | "label" | "unresolved"
  readonly catalogAt?: Date
}
