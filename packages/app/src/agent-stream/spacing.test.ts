import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";
import {
  getArenaGapBetweenStreamItems,
  getAssistantBlockSpacing,
  isSameAssistantBlockGroup,
} from "./spacing";

function assistantBlock(params: {
  id: string;
  blockGroupId: string;
  blockIndex: number;
  text?: string;
}): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id: params.id,
    blockGroupId: params.blockGroupId,
    blockIndex: params.blockIndex,
    text: params.text ?? "",
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function toolCallBlock(id: string): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "bash",
        arguments: "cmd",
        result: null,
        status: "executing",
      },
    },
  };
}

describe("isSameAssistantBlockGroup", () => {
  it("returns true for two assistant blocks with the same blockGroupId", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const b = assistantBlock({ id: "b", blockGroupId: "group-1", blockIndex: 1 });
    expect(isSameAssistantBlockGroup({ item: a, other: b })).toBe(true);
  });

  it("returns false for blocks from different groups", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const b = assistantBlock({ id: "b", blockGroupId: "group-2", blockIndex: 0 });
    expect(isSameAssistantBlockGroup({ item: a, other: b })).toBe(false);
  });

  it("returns false when one item is not an assistant_message", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const tc = toolCallBlock("tc-1");
    expect(isSameAssistantBlockGroup({ item: a, other: tc })).toBe(false);
  });

  it("returns false for null neighbors", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(isSameAssistantBlockGroup({ item: a, other: null })).toBe(false);
  });
});

describe("getAssistantBlockSpacing", () => {
  it("returns default for non-assistant items", () => {
    const tc = toolCallBlock("tc-1");
    expect(getAssistantBlockSpacing({ item: tc, aboveItem: null, belowItem: null })).toBe(
      "default",
    );
  });

  it("returns default when no same-group neighbors exist", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(getAssistantBlockSpacing({ item: a, aboveItem: null, belowItem: null })).toBe("default");
  });

  it("returns compactTop when the item above is in the same block group", () => {
    const above = assistantBlock({ id: "above", blockGroupId: "group-1", blockIndex: 0 });
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 1 });
    expect(getAssistantBlockSpacing({ item, aboveItem: above, belowItem: null })).toBe(
      "compactTop",
    );
  });

  it("returns compactBottom when the item below is in the same block group", () => {
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 0 });
    const below = assistantBlock({ id: "below", blockGroupId: "group-1", blockIndex: 1 });
    expect(getAssistantBlockSpacing({ item, aboveItem: null, belowItem: below })).toBe(
      "compactBottom",
    );
  });

  it("returns compactBoth when both neighbors are in the same block group", () => {
    const above = assistantBlock({ id: "above", blockGroupId: "group-1", blockIndex: 0 });
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 1 });
    const below = assistantBlock({ id: "below", blockGroupId: "group-1", blockIndex: 2 });
    expect(getAssistantBlockSpacing({ item, aboveItem: above, belowItem: below })).toBe(
      "compactBoth",
    );
  });

  it("spans the history/live-head boundary: tail gets compactBottom, head gets compactTop", () => {
    const tailBlock = assistantBlock({
      id: "group-1:block:0",
      blockGroupId: "group-1",
      blockIndex: 0,
      text: "First paragraph",
    });
    const headBlock = assistantBlock({
      id: "group-1:head",
      blockGroupId: "group-1",
      blockIndex: 1,
      text: "Second paragraph",
    });

    expect(
      getAssistantBlockSpacing({ item: tailBlock, aboveItem: null, belowItem: headBlock }),
    ).toBe("compactBottom");
    expect(
      getAssistantBlockSpacing({ item: headBlock, aboveItem: tailBlock, belowItem: null }),
    ).toBe("compactTop");
  });
});

describe("getArenaGapBetweenStreamItems", () => {
  const text = (id: string) => assistantBlock({ id, blockGroupId: id, blockIndex: 0 });
  const work = toolCallBlock("work");
  const thought: StreamItem = {
    kind: "thought",
    id: "t",
    text: "t",
    status: "ready",
    timestamp: new Date(0),
  };
  const subagent: StreamItem = {
    kind: "tool_call",
    id: "sub",
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "opencode",
        callId: "sub",
        name: "task",
        status: "completed",
        error: null,
        detail: { type: "sub_agent", description: "Read", childSessionId: "c", log: "" },
      },
    },
  };

  it("keeps a text against the work it led into, as the pane does", () => {
    expect(getArenaGapBetweenStreamItems(text("a"), work)).toBe(0);
    expect(getArenaGapBetweenStreamItems(text("a"), thought)).toBe(0);
  });

  it("starts every other block one gap down", () => {
    expect(getArenaGapBetweenStreamItems(text("a"), text("b"))).toBe(SPACING[3]);
    expect(getArenaGapBetweenStreamItems(text("a"), subagent)).toBe(SPACING[3]);
    expect(getArenaGapBetweenStreamItems(work, text("b"))).toBe(SPACING[3]);
    expect(getArenaGapBetweenStreamItems(work, subagent)).toBe(SPACING[3]);
    expect(getArenaGapBetweenStreamItems(subagent, text("b"))).toBe(SPACING[3]);
  });

  it("keeps work under the subagent before it, a status line's step below", () => {
    expect(getArenaGapBetweenStreamItems(subagent, thought)).toBe(SPACING[0.5]);
  });
});
