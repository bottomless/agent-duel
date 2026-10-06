import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";

interface ForkTitleParts {
  base: string;
  index: number;
}

function splitForkTitle(title: string): ForkTitleParts {
  const match = /^(.*) \((\d+)\)$/.exec(title);
  if (!match) return { base: title, index: 1 };
  const index = Number.parseInt(match[2] ?? "1", 10);
  if (index < 2) return { base: title, index: 1 };
  return {
    base: match[1]?.trim() || title,
    index,
  };
}

function buildForkTitle(base: string, index: number): string {
  const suffix = ` (${index})`;
  const availableBaseLength = MAX_EXPLICIT_AGENT_TITLE_CHARS - suffix.length;
  return `${base.slice(0, availableBaseLength).trimEnd()}${suffix}`;
}

export function resolveNextForkTitle(input: {
  sourceWorkspaceName?: string | null;
  sourceAgentTitle?: string | null;
  existingTitles: Iterable<string | null | undefined>;
  fallbackTitle: string;
}): string {
  const normalizedSource =
    input.sourceWorkspaceName?.trim() ||
    input.sourceAgentTitle?.trim() ||
    input.fallbackTitle.trim() ||
    "New session";
  const source = splitForkTitle(normalizedSource);
  let highestIndex = source.index;

  for (const existingTitle of input.existingTitles) {
    const normalizedTitle = existingTitle?.trim();
    if (!normalizedTitle) continue;
    const existing = splitForkTitle(normalizedTitle);
    if (
      existing.base === source.base ||
      (existing.index > 1 && normalizedTitle === buildForkTitle(source.base, existing.index))
    ) {
      highestIndex = Math.max(highestIndex, existing.index);
    }
  }

  return buildForkTitle(source.base, highestIndex + 1);
}
