import type { ArenaHistoryItem, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";

/** The pool's display names, for identities the reveal spells out as slugs. */
export function arenaModelDisplayName(raw: string | undefined): string {
  if (!raw) return "Unknown model";
  const value = raw.toLowerCase();
  if (value.includes("glm-5.2")) return "GLM 5.2";
  if (value.includes("qwen3.8-max")) return "Qwen 3.8 Max";
  if (value.includes("deepseek-v4-pro")) return "DeepSeek V4 Pro 0813";
  if (value.includes("deepseek-v4-flash")) return "DeepSeek V4 Flash";
  return raw;
}

/** `Agent A`, or `Agent A · Qwen 3.8 Max` once the vote has revealed the model. */
export function arenaContestantLabel(
  side: ArenaSide,
  identities: ArenaHistoryItem["identities"] | undefined,
): string {
  const label = `Agent ${side.toUpperCase()}`;
  if (!identities) return label;
  return `${label} · ${arenaModelDisplayName(identities[side].name)}`;
}
