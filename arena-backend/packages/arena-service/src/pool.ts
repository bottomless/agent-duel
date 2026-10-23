export type ModelProfile = {
  readonly displayName: string
  readonly slug: string
  readonly canonicalSlug: string
  readonly contextWindow: number
  /** Relative draw weight, default 1. Must be finite and positive; omit a profile to disable it. */
  readonly selectionWeight?: number
  /** Sent to OpenRouter as `provider`. */
  readonly routing: Readonly<Record<string, unknown>>
  /** Null enables reasoning without an effort level for models that do not expose one. */
  readonly reasoningEffort?: "high" | "xhigh" | null
}

export type ModelPool = readonly ModelProfile[]

type CatalogModel = {
  readonly id?: unknown
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
    const model = catalog.find(
      (item) =>
        item.canonical_slug === profile.canonicalSlug ||
        (profile.canonicalSlug === profile.slug && item.id === profile.slug),
    )
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
    const effort = profile.reasoningEffort === undefined ? "high" : profile.reasoningEffort
    if (
      !parameters.has("reasoning") ||
      (effort !== null && (!parameters.has("reasoning_effort") || !efforts.has(effort)))
    ) {
      throw new Error(`Arena contestant does not support ${effort ?? "enabled"} reasoning: ${profile.displayName}`)
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

function randomValue(random: () => number) {
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Arena assignment randomness must return a finite value in [0, 1)")
  }
  return value
}

export function samplePair(pool: ModelPool, random: () => number = Math.random): readonly [ModelProfile, ModelProfile] {
  if (pool.length < 2) throw new Error("Arena model pool could not produce a pair")
  const a = sampleOne(pool, random)
  const remaining = pool.filter((profile) => profile !== a)
  const b = sampleOne(remaining, random)
  // Weighted first and second draws have different distributions. Randomize sides so weight
  // changes exposure without favoring a contestant's placement on A or B.
  return randomValue(random) < 0.5 ? [a, b] : [b, a]
}

export function sampleOne(pool: ModelPool, random: () => number = Math.random) {
  const weighted = pool.map((profile) => {
    const weight = profile.selectionWeight ?? 1
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Arena contestant selection weight must be finite and positive: ${profile.displayName}`)
    }
    return { profile, weight }
  })
  const total = weighted.reduce((sum, { weight }) => sum + weight, 0)
  if (!Number.isFinite(total) || total <= 0) throw new Error("Arena model pool has an invalid total selection weight")
  const target = randomValue(random) * total
  let cumulative = 0
  for (const { profile, weight } of weighted) {
    cumulative += weight
    if (target < cumulative) return profile
  }
  // Multiplication can round a value just below 1 up to the total.
  const last = pool.at(-1)
  if (!last) throw new Error("Arena model pool could not produce a contestant")
  return last
}
