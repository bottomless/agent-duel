import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export type ArchivedChatSection = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

export type ArchivedChatListItem =
  | { kind: "heading"; key: string; section: ArchivedChatSection }
  | { kind: "chat"; key: string; agent: AggregatedAgent };

const SECTION_ORDER = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
] as const satisfies readonly ArchivedChatSection[];

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function deriveArchivedChatSection(lastActivityAt: Date, now: Date): ArchivedChatSection {
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(lastActivityAt);
  if (day >= today) return "today";
  if (day >= today - DAY_MS) return "yesterday";
  const daysAgo = Math.floor((today - day) / DAY_MS);
  if (daysAgo <= 7) return "thisWeek";
  if (daysAgo <= 30) return "thisMonth";
  return "older";
}

/**
 * Day headings at rest. A search result is ordered by relevance, so it stays one
 * flat list: a heading there would claim an order the list no longer has.
 */
export function buildArchivedChatListItems(input: {
  agents: readonly AggregatedAgent[];
  grouped: boolean;
  now?: Date;
}): ArchivedChatListItem[] {
  const chat = (agent: AggregatedAgent): ArchivedChatListItem => ({
    kind: "chat",
    key: `${agent.serverId}:${agent.id}`,
    agent,
  });
  if (!input.grouped) {
    return input.agents.map(chat);
  }

  const now = input.now ?? new Date();
  const bySection = new Map<ArchivedChatSection, AggregatedAgent[]>();
  for (const agent of input.agents) {
    const section = deriveArchivedChatSection(agent.lastActivityAt, now);
    const agents = bySection.get(section);
    if (agents) {
      agents.push(agent);
    } else {
      bySection.set(section, [agent]);
    }
  }

  const items: ArchivedChatListItem[] = [];
  for (const section of SECTION_ORDER) {
    const agents = bySection.get(section);
    if (!agents) continue;
    items.push({ kind: "heading", key: `heading:${section}`, section });
    for (const agent of agents) items.push(chat(agent));
  }
  return items;
}
