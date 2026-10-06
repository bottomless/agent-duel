export type ModelProfile = {
  readonly displayName: string
  readonly slug: string
  readonly canonicalSlug: string
  readonly contextWindow: number
  /** Sent to OpenRouter as `provider`. */
  readonly routing: Readonly<Record<string, unknown>>
}

export type ModelPool = readonly ModelProfile[]

type CatalogModel = {
  readonly canonical_slug?: unknown
  readonly context_length?: unknown
  readonly architecture?: { readonly input_modalities?: unknown; readonly output_modalities?: unknown }
  readonly supported_parameters?: unknown
  readonly reasoning?: { readonly supported_efforts?: unknown }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown) {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
}

export function validateCatalog(pool: ModelPool, value: unknown) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("OpenRouter returned an invalid model catalog")
  const catalog = value.data.filter(record) as CatalogModel[]
  for (const profile of pool) {
    const model = catalog.find((item) => item.canonical_slug === profile.canonicalSlug)
    if (!model) {
      throw new Error(`Arena contestant is unavailable: ${profile.displayName}`)
    }
    const parameters = strings(model.supported_parameters)
    const inputs = strings(model.architecture?.input_modalities)
    const outputs = strings(model.architecture?.output_modalities)
    const efforts = strings(model.reasoning?.supported_efforts)
    if (model.context_length !== profile.contextWindow) {
      throw new Error(`Arena contestant context window drifted: ${profile.displayName}`)
    }
    if (!inputs.has("text") || !outputs.has("text") || !parameters.has("tools") || !parameters.has("tool_choice")) {
      throw new Error(`Arena contestant is missing required text or tool capabilities: ${profile.displayName}`)
    }
    // Every contestant is offered the same image attachments. One that cannot read them would lose
    // the battle to its input, and refusing the send only for that draw would reveal the model.
    if (!inputs.has("image")) {
      throw new Error(`Arena contestant cannot read images: ${profile.displayName}`)
    }
    if (!parameters.has("reasoning") || !parameters.has("reasoning_effort") || !efforts.has("high")) {
      throw new Error(`Arena contestant does not support High reasoning: ${profile.displayName}`)
    }
  }
}

/** Checks the pool against the models this API key can reach, which honours the key's own account settings. */
export async function validateOpenRouter(
  pool: ModelPool,
  apiKey: string,
  execute: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
) {
  const response = await execute("https://openrouter.ai/api/v1/models/user", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`OpenRouter model catalog request failed with status ${response.status}`)
  validateCatalog(pool, await response.json())
}

function index(random: () => number, length: number) {
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Arena assignment randomness must return a finite value in [0, 1)")
  }
  return Math.floor(value * length)
}

export function samplePair(pool: ModelPool, random: () => number = Math.random): readonly [ModelProfile, ModelProfile] {
  const first = index(random, pool.length)
  const second = index(random, pool.length - 1)
  const a = pool[first]
  const b = pool[second >= first ? second + 1 : second]
  if (!a || !b) throw new Error("Arena model pool could not produce a pair")
  return [a, b]
}

export function sampleOne(pool: ModelPool, random: () => number = Math.random) {
  const selected = pool[index(random, pool.length)]
  if (!selected) throw new Error("Arena model pool could not produce a contestant")
  return selected
}
