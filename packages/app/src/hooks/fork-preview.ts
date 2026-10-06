import type { StreamItem } from "@/types/stream";

export function selectForkBoundaryItemId(input: {
  tail: readonly StreamItem[];
  head?: readonly StreamItem[];
  forkedAt: Date;
}): string | undefined {
  const items = [...input.tail, ...(input.head ?? [])];
  return items.findLast((item) => item.timestamp <= input.forkedAt)?.id;
}

export function selectForkBoundaryItemIdForAgent(input: {
  agentId: string;
  forkSourceAgentId: string | null;
  tail: readonly StreamItem[];
  head?: readonly StreamItem[];
  forkedAt: Date;
}): string | undefined {
  if (!input.forkSourceAgentId || input.forkSourceAgentId === input.agentId) {
    return undefined;
  }
  return selectForkBoundaryItemId(input);
}
