import type { ModelProfile } from "./pool"

// /api/v1/providers pairs these response labels with the slugs accepted in `provider.only`.
// In particular, OpenRouter calls Vertex "Google", not "Google Vertex" or "google".
function routingSlug(provider: string | null) {
  switch (provider) {
    case "Google":
    case "google-vertex":
      return "google-vertex"
    case "Google AI Studio":
    case "google-ai-studio":
      return "google-ai-studio"
  }
}

/** Intersect the signing provider with the draw's policy. `only: []` is not a denial. */
export function geminiSignatureRouting(policy: ModelProfile["routing"], signers: ReadonlySet<string | null>) {
  if (!signers.size) return policy
  const slugs = new Set(Array.from(signers, routingSlug).filter((slug) => slug !== undefined))
  const [slug] = slugs
  if (!slug) {
    const reason = signers.has(null) ? "missing signer" : "unknown signer"
    console.warn(`[arena-service] Gemini signature pinning skipped: ${reason}`)
    return policy
  }
  if (slugs.size !== 1) return undefined
  if (policy.only === undefined) return { ...policy, only: [slug] }
  if (!Array.isArray(policy.only)) return undefined
  // Keep tier/region restrictions (e.g. google-vertex/global); replacing them with the base
  // provider would admit endpoints the pool excluded. All other filters still apply upstream.
  const only = policy.only.filter(
    (tag: unknown) => typeof tag === "string" && (tag === slug || tag.startsWith(`${slug}/`)),
  )
  return only.length ? { ...policy, only } : undefined
}
