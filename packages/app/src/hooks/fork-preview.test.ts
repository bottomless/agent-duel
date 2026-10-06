import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { selectForkBoundaryItemId, selectForkBoundaryItemIdForAgent } from "./fork-preview";

function assistant(id: string, seq: number, text = id): StreamItem {
  return {
    kind: "assistant_message",
    id,
    messageId: id,
    timelineCursor: { epoch: "timeline-1", seq },
    text,
    timestamp: new Date(seq),
  };
}

describe("selectForkBoundaryItemId", () => {
  it("anchors before messages sent after the fork was created", () => {
    expect(
      selectForkBoundaryItemId({
        tail: [assistant("inherited", 1), assistant("new-prompt", 3)],
        forkedAt: new Date(2),
      }),
    ).toBe("inherited");
  });

  it("uses the end of inherited history before a new prompt exists", () => {
    expect(
      selectForkBoundaryItemId({
        tail: [assistant("history", 1)],
        head: [assistant("live", 2)],
        forkedAt: new Date(2),
      }),
    ).toBe("live");
  });
});

describe("selectForkBoundaryItemIdForAgent", () => {
  it("does not mark a primary chat", () => {
    expect(
      selectForkBoundaryItemIdForAgent({
        agentId: "primary",
        forkSourceAgentId: null,
        tail: [assistant("history", 1)],
        forkedAt: new Date(2),
      }),
    ).toBeUndefined();
  });

  it("ignores a fork label copied onto its own source chat", () => {
    expect(
      selectForkBoundaryItemIdForAgent({
        agentId: "primary",
        forkSourceAgentId: "primary",
        tail: [assistant("history", 1)],
        forkedAt: new Date(2),
      }),
    ).toBeUndefined();
  });

  it("marks history in the fork target", () => {
    expect(
      selectForkBoundaryItemIdForAgent({
        agentId: "fork",
        forkSourceAgentId: "primary",
        tail: [assistant("history", 1)],
        forkedAt: new Date(2),
      }),
    ).toBe("history");
  });
});
