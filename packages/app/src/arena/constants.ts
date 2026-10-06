export const ARENA_PROVIDER = "opencode";
// Agent creation needs an initial model. The Arena backend replaces it with the
// session's persisted random contestant before every prompt.
export const ARENA_BOOTSTRAP_MODEL = "openrouter/deepseek/deepseek-v4-flash";

export const ARENA_THINKING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

export type ArenaThinkingLevel = (typeof ARENA_THINKING_OPTIONS)[number]["id"];
export const DEFAULT_ARENA_THINKING: ArenaThinkingLevel = "high";

// The battle engine refuses a message with more images than this (`MAX_IMAGES` in
// arena-backend/packages/opencode/src/arena/attachments.ts); the composer holds a battle message to it.
export const ARENA_MAX_IMAGES = 4;

export const EARLY_BATTLE_TOAST = "Battle decided early, data marked accordingly.";

export function arenaAgentPreferenceKey(serverId: string, agentId: string): string {
  return `${serverId}:agent:${agentId}`;
}

export function arenaDraftPreferenceKey(serverId: string, draftId: string): string {
  return `${serverId}:draft:${draftId}`;
}
