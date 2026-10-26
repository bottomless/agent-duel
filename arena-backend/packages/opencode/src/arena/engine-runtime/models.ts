import { Model } from "@opencode/schema"
import type { Provider as ProviderSchema } from "@opencode/schema/provider"
import type { Model as ModelSchema } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Money } from "@opencode/schema/money"
import { contestant, medium, highReasoning, xhighReasoning } from "../model-profile"

export const PROVIDER_ID = Provider.ID.make("arena")
export const CONTESTANT_MODEL_ID = Model.ID.make("contestant")
export const MEDIUM_MODEL_ID = Model.ID.make("medium")

export const CONTESTANT_CONTEXT_WINDOW = contestant.contextWindow
export const CONTESTANT_OUTPUT_LIMIT = contestant.outputLimit
export const MEDIUM_CONTEXT_WINDOW = medium.contextWindow
export const MEDIUM_OUTPUT_LIMIT = medium.outputLimit

export const CONTESTANT_IDENTITY = [
  "Your model name and provider are hidden from the user until the vote or a reveal.",
  "If the user asks which model you are or who made you, say that your identity is hidden until then.",
  "Do not guess, name, or hint at a model, version, or company, and do not try to find out from configuration files or the environment.",
].join(" ")

const cost = [
  {
    input: Money.USDPerMillionTokens.zero,
    output: Money.USDPerMillionTokens.zero,
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
  },
]

function model(input: {
  readonly id: ModelSchema.ID
  readonly name: string
  readonly context: number
  readonly output: number
  readonly variant: ModelSchema.VariantID
  readonly body: Record<string, unknown>
}): ModelSchema.Info {
  return {
    id: input.id,
    modelID: input.id,
    providerID: PROVIDER_ID,
    name: input.name,
    family: Model.Family.make("arena"),
    package: "aisdk:@openrouter/ai-sdk-provider",
    headers: {},
    body: {},
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
      temperature: true,
    },
    variants: [{ id: input.variant, body: input.body }],
    time: { released: 0 },
    cost,
    status: "active",
    enabled: true,
    limit: { context: input.context, output: input.output },
  }
}

export const contestantModel = model({
  id: CONTESTANT_MODEL_ID,
  name: "Contestant",
  context: CONTESTANT_CONTEXT_WINDOW,
  output: CONTESTANT_OUTPUT_LIMIT,
  variant: Model.VariantID.make("high"),
  body: { reasoning: highReasoning.reasoning },
})

export const mediumModel = model({
  id: MEDIUM_MODEL_ID,
  name: "Contestant",
  context: MEDIUM_CONTEXT_WINDOW,
  output: MEDIUM_OUTPUT_LIMIT,
  variant: Model.VariantID.make("xhigh"),
  body: { reasoning: xhighReasoning.reasoning },
})

export const provider = {
  id: PROVIDER_ID,
  name: "Contestant",
  activation: "enabled",
  package: "aisdk:@openrouter/ai-sdk-provider",
  headers: {},
  body: {},
} satisfies ProviderSchema.Info

export const models = [contestantModel, mediumModel] as const

export function modelForSize(size: "medium" | "frontier" | undefined) {
  return size === "medium" ? mediumModel : contestantModel
}

export function modelReference(size: "medium" | "frontier" | undefined, variant?: "high" | "xhigh") {
  const selected = modelForSize(size)
  const chosen = variant ?? (size === "medium" ? "xhigh" : "high")
  return `${PROVIDER_ID}/${selected.id}#${chosen}`
}

export * as ArenaEngineModels from "./models.js"
