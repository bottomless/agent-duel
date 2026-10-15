import type { ModelPool, ModelProfile } from "./pool"

// The control plane's development set, and the pool a BYOK source build draws
// from on the user's own key. The hosted production pool stays in the control
// plane; this file ships in every desktop engine.
export const defaultPool = [
  {
    displayName: "GLM 5.3 FlashX",
    slug: "z-ai/glm-5.3-flashx",
    canonicalSlug: "z-ai/glm-5.3-flashx-20260918",
    contextWindow: 1_048_576,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 2.1, completion: 6.6 },
    },
  },
  {
    displayName: "Qwen 3.8 Max",
    slug: "qwen/qwen3.8-max-0902",
    canonicalSlug: "qwen/qwen3.8-max-20260902",
    contextWindow: 1_000_000,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 3, completion: 9 },
    },
  },
  {
    displayName: "Grok 4.6",
    slug: "x-ai/grok-4.6",
    canonicalSlug: "x-ai/grok-4.6-20260810",
    contextWindow: 500_000,
    routing: {
      sort: "throughput",
      require_parameters: true,
      max_price: { prompt: 3, completion: 9 },
    },
  },
] as const satisfies ModelPool

export const mediumModel = {
  displayName: "GPT Luna 5.6 Xhigh",
  slug: "openai/gpt-5.6-luna",
  canonicalSlug: "openai/gpt-5.6-luna-20260709",
  contextWindow: 1_050_000,
  routing: {
    sort: "throughput",
    require_parameters: true,
  },
  reasoningEffort: "xhigh",
} as const satisfies ModelProfile
