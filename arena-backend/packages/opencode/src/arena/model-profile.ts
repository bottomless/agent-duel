// The desktop runtime intentionally knows one capability envelope and no model
// identities. The control plane replaces this placeholder after authenticating
// the account and matching a battle-scoped opaque assignment ID.
export const contestant = {
  id: "contestant",
  contextWindow: 500_000,
  outputLimit: 131_072,
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

export const highReasoning = {
  variant: "high",
  reasoning: {
    effort: "high",
  },
} as const

export * as ArenaModelProfile from "./model-profile"
