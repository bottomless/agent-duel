interface ComposerContextWindowInput {
  hasAgent: boolean;
  provider: string | null;
  model: string | null;
  maxTokens: number | null;
  usedTokens: number | null;
  pending: boolean;
}

export function shouldShowComposerContextWindow(input: ComposerContextWindowInput): boolean {
  if (!input.hasAgent) return false;

  // Arena's OpenCode runtime can restore sessions before their model is known.
  // Never expose cached usage or reserve a loading slot for a blinded model.
  const isArena =
    input.provider === "opencode" && (input.model === null || input.model.startsWith("arena/"));
  if (isArena) return false;

  const hasData = input.maxTokens !== null && input.usedTokens !== null;
  return hasData || input.pending;
}
