import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { buildArchivedChatListItems, deriveArchivedChatSection } from "./archived-chats-model";

const NOW = new Date(2026, 9, 9, 15, 0);

function archivedChat(id: string, lastActivityAt: Date): AggregatedAgent {
  return {
    id,
    serverId: "server-1",
    serverLabel: "Local",
    title: id,
    status: "closed",
    lastActivityAt,
    cwd: "/repo",
    workspaceId: `ws-${id}`,
    provider: "opencode",
    requiresAttention: false,
    archivedAt: lastActivityAt,
    createdAt: lastActivityAt,
    labels: {},
  };
}

describe("deriveArchivedChatSection", () => {
  it("buckets by calendar day, not by 24-hour distance", () => {
    expect(deriveArchivedChatSection(new Date(2026, 9, 9, 0, 5), NOW)).toBe("today");
    expect(deriveArchivedChatSection(new Date(2026, 9, 8, 23, 55), NOW)).toBe("yesterday");
    expect(deriveArchivedChatSection(new Date(2026, 9, 2, 12, 0), NOW)).toBe("thisWeek");
    expect(deriveArchivedChatSection(new Date(2026, 8, 20, 12, 0), NOW)).toBe("thisMonth");
    expect(deriveArchivedChatSection(new Date(2026, 6, 1, 12, 0), NOW)).toBe("older");
  });
});

describe("buildArchivedChatListItems", () => {
  const agents = [
    archivedChat("landing-page", new Date(2026, 9, 9, 14, 0)),
    archivedChat("hero-image", new Date(2026, 9, 8, 10, 0)),
    archivedChat("pricing", new Date(2026, 6, 1, 10, 0)),
  ];

  it("puts a day heading before each day that has chats, in the list's order", () => {
    const items = buildArchivedChatListItems({ agents, grouped: true, now: NOW });

    expect(items.map((item) => (item.kind === "heading" ? item.section : item.agent.id))).toEqual([
      "today",
      "landing-page",
      "yesterday",
      "hero-image",
      "older",
      "pricing",
    ]);
  });

  it("keeps a ranked search result flat and in the order it was given", () => {
    const ranked = [agents[2], agents[0]];

    const items = buildArchivedChatListItems({ agents: ranked, grouped: false, now: NOW });

    expect(items).toEqual([
      { kind: "chat", key: "server-1:pricing", agent: ranked[0] },
      { kind: "chat", key: "server-1:landing-page", agent: ranked[1] },
    ]);
  });
});
