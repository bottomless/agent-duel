import type { ArenaDb, ArenaRecord } from "./collection"
import type { EndpointLabel } from "./metrics"
import type { ModelProfile } from "./pool"

// OpenRouter names the provider that served a call but never its quantization, so the label comes
// from the endpoint list the control plane saves in this collection. The label is the catalog's
// claim about the endpoint: it records what OpenRouter listed, and does not prove what ran.
const CATALOG = "arenaEndpointCatalog"

export type CatalogEndpoint = {
  readonly tag: string
  readonly providerName: string
  readonly quantization: string
}

export type EndpointCatalog = ArenaRecord & {
  readonly slug: string
  readonly capturedAt: Date
  readonly endpoints: ReadonlyArray<CatalogEndpoint>
}

const READ_TIMEOUT_MS = 2_000
// The catalog changes at most hourly, and `catalogAt` names the copy that gave each label.
const CACHE_TTL_MS = 15 * 60_000

const UNRESOLVED: EndpointLabel = { quantization: "unresolved", admittedBy: "unresolved" }

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

// OpenRouter's provider filters: a base slug covers every endpoint of that provider, a full slug that endpoint.
function listed(entries: ReadonlyArray<string>, tag: string) {
  return entries.some((entry) => tag === entry || tag.startsWith(`${entry}/`))
}

// Price and tool support stay out: a compaction call sends no tools, and an endpoint over the price
// cap only makes a provider's result ambiguous when its label also differs.
function routable(routing: ModelProfile["routing"], endpoint: CatalogEndpoint) {
  const only = strings(routing.only)
  const quantizations = strings(routing.quantizations)
  const ignore = strings(routing.ignore)
  return (
    (!only || listed(only, endpoint.tag)) &&
    (!quantizations || quantizations.includes(endpoint.quantization)) &&
    !(ignore && listed(ignore, endpoint.tag))
  )
}

function admittedBy(model: ModelProfile, tags: ReadonlyArray<string>): EndpointLabel["admittedBy"] {
  const policy = model.endpointPolicy
  if (!policy) return "unresolved"
  if (tags.some((tag) => listed(policy.firstParty, tag))) return "first-party"
  if (tags.some((tag) => listed(policy.trustedHosts, tag))) return "trusted-host"
  if (tags.some((tag) => listed(policy.approved, tag))) return "label"
  return "unresolved"
}

/** Finds the label for a call from the provider name, the assignment's stored model and a catalog copy. */
export function resolveEndpointLabel(
  model: ModelProfile,
  provider: string | undefined,
  catalog: Pick<EndpointCatalog, "capturedAt" | "endpoints"> | null,
): EndpointLabel {
  if (!provider || !catalog) return UNRESOLVED
  const candidates = catalog.endpoints.filter(
    (endpoint) => endpoint.providerName === provider && routable(model.routing, endpoint),
  )
  if (!candidates.length) return { ...UNRESOLVED, catalogAt: catalog.capturedAt }
  const labels = [...new Set(candidates.map((endpoint) => endpoint.quantization))].sort()
  return {
    quantization: labels.length === 1 ? labels[0]! : "ambiguous",
    ...(labels.length > 1 ? { quantizationCandidates: labels } : {}),
    admittedBy: admittedBy(
      model,
      candidates.map((endpoint) => endpoint.tag),
    ),
    catalogAt: catalog.capturedAt,
  }
}

export type EndpointLabelReader = (
  db: ArenaDb,
  model: ModelProfile,
  provider: string | undefined,
) => Promise<EndpointLabel>

/**
 * Never throws and never waits long: this runs before the metric write and the stream close, so a
 * stalled catalog read must not hold a finished call open or lose its row.
 *
 * Keeps the newest copy of each model for the life of the service. A failed read and a model with
 * no copy yet stay out of the cache, so the next call reads again.
 */
export function endpointLabelReader(now: () => Date, timeoutMs = READ_TIMEOUT_MS): EndpointLabelReader {
  const cache = new Map<string, { readonly catalog: EndpointCatalog; readonly expiresAt: number }>()
  return async (db, model, provider) => {
    if (!provider) return UNRESOLVED
    const cached = cache.get(model.slug)
    if (cached && now().getTime() < cached.expiresAt) return resolveEndpointLabel(model, provider, cached.catalog)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), timeoutMs)
    })
    try {
      const read = db
        .collection<EndpointCatalog>(CATALOG)
        .find({ slug: model.slug })
        .sort({ capturedAt: -1 })
        .limit(1)
        .next()
      const catalog = await Promise.race([read, expired])
      if (catalog) cache.set(model.slug, { catalog, expiresAt: now().getTime() + CACHE_TTL_MS })
      return resolveEndpointLabel(model, provider, catalog)
    } catch {
      console.error("[arena-service] Arena endpoint catalog could not be read")
      return UNRESOLVED
    } finally {
      clearTimeout(timer)
    }
  }
}
