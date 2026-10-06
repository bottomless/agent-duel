/**
 * Which company made the model behind a contestant.
 *
 * A battle hides its models until the vote lands, and what it reveals is the
 * profile's display name — `Qwen 3.8 Max`, not `qwen/qwen3.8-max-20260803`
 * (arena-backend `service.ts`, `model: profile.displayName`). Slug-shaped
 * names still reach here from older data and from the single-model path, so
 * match both shapes, and match the family name as well as the vendor's: a
 * profile is as likely to be called `Sonnet 4.6` as `Claude Sonnet 4.6`.
 *
 * A model whose name carries neither gets no mark rather than a wrong one.
 */
export const MODEL_VENDORS = [
  "anthropic",
  "deepseek",
  "google",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "openai",
  "qwen",
  "xai",
  "zai",
] as const;

export type ModelVendor = (typeof MODEL_VENDORS)[number];

// Ordered: a name that matches two rules belongs to the first. Patterns anchor
// on a word start but usually not a word end, because a family name runs
// straight into its version — `qwen3.8-max`, `gpt-5.2`, `glm-5.2`. The short
// ambiguous ones (`o3`, `k2`) anchor at both ends so they cannot match inside
// a longer word.
const VENDOR_PATTERNS: ReadonlyArray<readonly [ModelVendor, RegExp]> = [
  ["zai", /\b(?:z-?ai|zhipu|glm)/i],
  ["qwen", /\b(?:qwen|qwq)/i],
  ["deepseek", /\bdeep[\s-]?seek/i],
  ["xai", /\b(?:x-?ai|grok)/i],
  ["moonshot", /\b(?:moonshot|kimi)|\bk2\b/i],
  ["minimax", /\bmini[\s-]?max/i],
  ["anthropic", /\b(?:anthropic|claude|sonnet|opus|haiku)/i],
  ["openai", /\b(?:openai|gpt)|\bo[134]\b/i],
  ["google", /\b(?:google|gemini|gemma)/i],
  ["mistral", /\b(?:mistral|ministral|codestral|devstral|magistral|pixtral)/i],
  ["meta", /\b(?:meta|llama)/i],
];

export function arenaModelVendor(raw: string | undefined): ModelVendor | null {
  if (!raw) return null;
  for (const [vendor, pattern] of VENDOR_PATTERNS) {
    if (pattern.test(raw)) return vendor;
  }
  return null;
}
