import { describe, expect, it } from "vitest";
import {
  getArenaGapBetweenStreamItems,
  getAssistantMessageSpacing,
  getGapBetweenStreamItems,
} from "./spacing";
import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";

const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("keeps separate messages separated", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBeGreaterThan(0);
  });
});

describe("getArenaGapBetweenStreamItems", () => {
  const text = (id: string): StreamItem => ({
    kind: "assistant_message",
    id,
    text: "",
    timestamp: new Date(0),
  });
  const work: StreamItem = {
    kind: "tool_call",
    id: "work",
    timestamp: new Date(0),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: "work",
        toolName: "bash",
        arguments: "cmd",
        result: null,
        status: "executing",
      },
    },
  };
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
