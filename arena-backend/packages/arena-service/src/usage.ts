import { addUsageTotals, type UsageTotals, usageTotalsVersion } from "./metrics"

export { addUsageTotals, type UsageTotals, usageTotalsVersion } from "./metrics"

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sourceFor(value: unknown): RecordValue | undefined {
  if (!record(value)) return undefined
  if (record(value.usage)) return value.usage
  if (record(value.message) && record(value.message.usage)) return value.message.usage
  if (record(value.response) && record(value.response.usage)) return value.response.usage
  if (record(value.data) && record(value.data.usage)) return value.data.usage
  // A direct usage object is useful to callers parsing a response body or a fixture.
  return "prompt_tokens" in value ||
    "input_tokens" in value ||
    "completion_tokens" in value ||
    "output_tokens" in value ||
    "cache_read_input_tokens" in value ||
    "cache_creation_input_tokens" in value
    ? value
    : undefined
}

function details(source: RecordValue, ...keys: string[]) {
  for (const key of keys) if (record(source[key])) return source[key]
  return undefined
}

type UsageState = {
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  upstreamInferenceCost?: number
  seen: boolean
  final: boolean
  anthropic: boolean
  anthropicCacheReadReported: boolean
  anthropicCacheWriteReported: boolean
}

type NumericUsageKey =
  | "promptTokens"
  | "completionTokens"
  | "reasoningTokens"
  | "totalTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cost"
  | "upstreamInferenceCost"

function setNumeric(state: UsageState, key: NumericUsageKey, value: unknown) {
  const parsed = finite(value)
  if (parsed === undefined) return
  switch (key) {
    case "promptTokens":
      state.promptTokens = parsed
      break
    case "completionTokens":
      state.completionTokens = parsed
      break
    case "reasoningTokens":
      state.reasoningTokens = parsed
      break
    case "totalTokens":
      state.totalTokens = parsed
      break
    case "cacheReadTokens":
      state.cacheReadTokens = parsed
      break
    case "cacheWriteTokens":
      state.cacheWriteTokens = parsed
      break
    case "cost":
      state.cost = parsed
      break
    case "upstreamInferenceCost":
      state.upstreamInferenceCost = parsed
      break
  }
}

function observeValue(state: UsageState, value: unknown) {
  const source = sourceFor(value)
  if (!source) return
  state.seen = true
  const type = record(value) && typeof value.type === "string" ? value.type : undefined
  const provisional = type === "message_start"
  const anthropic =
    type === "message" ||
    type === "message_start" ||
    type === "message_delta" ||
    type === "message_stop" ||
    (type === undefined && ("cache_read_input_tokens" in source || "cache_creation_input_tokens" in source))
  if (anthropic) {
    state.anthropic = true
    state.anthropicCacheReadReported ||= "cache_read_input_tokens" in source
    state.anthropicCacheWriteReported ||= "cache_creation_input_tokens" in source
  }
  state.final ||= !provisional
  const promptDetails = details(source, "prompt_tokens_details", "input_tokens_details")
  const completionDetails = details(source, "completion_tokens_details", "output_tokens_details")
  const cacheDetails = record(source.cache_tokens) ? source.cache_tokens : undefined
  const costDetails = record(source.cost_details) ? source.cost_details : undefined
  // Anthropic sends input usage in message_start and output usage in message_delta. Keep input/cache
  // fields from message_start, but never treat its provisional output/reasoning zero as final.
  setNumeric(state, "promptTokens", source.prompt_tokens ?? source.input_tokens)
  setNumeric(
    state,
    "cacheReadTokens",
    promptDetails?.cached_tokens ?? cacheDetails?.read ?? source.cache_read_tokens ?? source.cache_read_input_tokens,
  )
  setNumeric(
    state,
    "cacheWriteTokens",
    promptDetails?.cache_write_tokens ??
      cacheDetails?.write ??
      source.cache_write_tokens ??
      source.cache_creation_input_tokens,
  )
  setNumeric(state, "cost", source.cost ?? (record(value) ? value.cost : undefined))
  setNumeric(state, "upstreamInferenceCost", costDetails?.upstream_inference_cost)
  if (provisional) return
  // Every non-provisional usage packet is an authoritative cumulative snapshot. Reset omitted
  // generated fields so a prior reasoning=0 cannot masquerade as a provider-reported value.
  state.completionTokens = finite(source.completion_tokens ?? source.output_tokens)
  state.reasoningTokens = finite(completionDetails?.reasoning_tokens ?? source.reasoning_tokens)
  state.totalTokens = finite(source.total_tokens)
}

function value(state: UsageState, latencyMs: number): UsageTotals | undefined {
  if (!state.seen) return undefined
  const completionTokens = state.completionTokens ?? null
  return {
    promptTokens: state.promptTokens ?? null,
    completionTokens,
    reasoningTokens: state.reasoningTokens ?? null,
    totalTokens:
      state.totalTokens ??
      (state.promptTokens === undefined ||
      completionTokens === null ||
      (state.anthropic && (!state.anthropicCacheReadReported || !state.anthropicCacheWriteReported))
        ? null
        : state.promptTokens +
          completionTokens +
          (state.anthropic ? (state.cacheReadTokens ?? 0) + (state.cacheWriteTokens ?? 0) : 0)),
    cacheReadTokens: state.cacheReadTokens ?? null,
    cacheWriteTokens: state.cacheWriteTokens ?? null,
    cost: state.cost ?? null,
    ...(state.upstreamInferenceCost === undefined ? {} : { upstreamInferenceCost: state.upstreamInferenceCost }),
    attempts: 1,
    latencyMs,
    provenance: "provider",
    version: usageTotalsVersion,
  }
}

/** Parse one provider response or a sequence of SSE events. */
export function parseProviderUsage(input: unknown, latencyMs = 0): UsageTotals | undefined {
  const state: UsageState = {
    seen: false,
    final: false,
    anthropic: false,
    anthropicCacheReadReported: false,
    anthropicCacheWriteReported: false,
  }
  if (Array.isArray(input)) input.forEach((item) => observeValue(state, item))
  else observeValue(state, input)
  return value(state, latencyMs)
}

/** A message_start usage packet is provisional; only terminal/provider usage can finalize a call. */
export function hasFinalProviderUsage(input: unknown) {
  const state: UsageState = {
    seen: false,
    final: false,
    anthropic: false,
    anthropicCacheReadReported: false,
    anthropicCacheWriteReported: false,
  }
  if (Array.isArray(input)) input.forEach((item) => observeValue(state, item))
  else observeValue(state, input)
  return state.final
}

/** Stateful parser for streams whose usage is split across multiple terminal events. */
export function createProviderUsageParser(initialLatencyMs = 0) {
  const state: UsageState = {
    seen: false,
    final: false,
    anthropic: false,
    anthropicCacheReadReported: false,
    anthropicCacheWriteReported: false,
  }
  return {
    observe(input: unknown) {
      observeValue(state, input)
    },
    value(latencyMs = initialLatencyMs) {
      return value(state, latencyMs)
    },
    final() {
      return state.final
    },
  }
}

/** Aggregate usage while keeping completion/reasoning unknown if any call omitted it. */
export function aggregateUsage(values: readonly UsageTotals[]): UsageTotals | undefined {
  if (values.length === 0) return undefined
  const zero: UsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    attempts: 0,
    latencyMs: 0,
    provenance: "provider",
    version: usageTotalsVersion,
  }
  return values.reduce(addUsageTotals, zero)
}

export type RootUsageCall = {
  readonly generationID: string
  readonly runID: string
  readonly usage?: UsageTotals
  readonly classification?: "root" | "subagent" | "compaction"
  readonly requestKind?: "generation" | "compaction" | "utility"
  readonly sessionID: string
  readonly rootSessionID: string
  readonly opportunisticCompactionID?: string
  readonly engagementID?: string
}

export function isRootModelCall(call: RootUsageCall) {
  return call.sessionID === call.rootSessionID && call.classification === "root" && call.requestKind === "generation"
}
