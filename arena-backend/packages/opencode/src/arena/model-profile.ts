// The desktop runtime intentionally knows one capability envelope and no model
// identities. The control plane replaces this placeholder after authenticating
// the account and matching a battle-scoped opaque assignment ID.
export const contestant = {
  id: "contestant",
  contextWindow: 500_000,
  outputLimit: 131_072,
} as const

export const medium = {
  id: "medium",
  contextWindow: 1_050_000,
  outputLimit: 128_000,
} as const

// Session creation can carry this non-contestant placeholder before Arena has
// assigned a model. No battle request is routed with it.
export const bootstrapModel = {
  modelID: "deepseek/deepseek-v4-flash",
  metadataModelID: "deepseek/deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  routing: {
    sort: "throughput",
    require_parameters: true,
    max_price: { prompt: 0.15, completion: 0.3 },
  },
} as const

// Local metadata for the session placeholder; resolving it must work before any
// catalog download. Contestant inference uses the capability envelopes above.
export const bootstrapMetadata = {
  id: bootstrapModel.modelID,
  name: bootstrapModel.displayName,
  family: "deepseek-flash",
  release_date: "2026-04-24",
  attachment: false,
  reasoning: true,
  temperature: true,
  tool_call: true,
  interleaved: { field: "reasoning_content" },
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 1_048_576, output: 384_000 },
  cost: { input: 0.077, output: 0.154, cache_read: 0.0154 },
} as const

export const highReasoning = {
  variant: "high",
  reasoning: {
    effort: "high",
  },
} as const

export const xhighReasoning = {
  variant: "xhigh",
  reasoning: {
    effort: "xhigh",
  },
} as const

export * as ArenaModelProfile from "./model-profile"
