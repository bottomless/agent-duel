import { defaultModelLimits, type ModelLimits } from "@agent-duel/arena-service/pool"
import type { Provider } from "@/provider/provider"

// The desktop runtime intentionally knows one capability envelope and no model
// identities. The control plane replaces this placeholder after authenticating
// the account and matching a battle-scoped opaque assignment ID.
export const contestant = {
  id: "contestant",
  contextWindow: defaultModelLimits.context,
  outputLimit: defaultModelLimits.output,
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

/** Copy the model: cached provider metadata is shared with other sessions. */
export function withLimits(model: Provider.Model, limits?: ModelLimits): Provider.Model {
  if (!limits || model.providerID !== "arena") return model
  return {
    ...model,
    limit: {
      context: Math.min(model.limit.context, limits.context),
      output: Math.min(model.limit.output, limits.output),
    },
  }
}

export * as ArenaModelProfile from "./model-profile"
