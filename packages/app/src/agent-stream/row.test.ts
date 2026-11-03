import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";
import { renderStreamRow } from "./row";

const item: StreamItem = {
  kind: "tool_call",
  id: "winner-child",
  timestamp: new Date(0),
  payload: {
    source: "agent",
    data: {
      provider: "opencode",
      callId: "winner-child",
      name: "subagent",
      status: "completed",
      error: null,
      detail: { type: "sub_agent", childSessionId: "copied-child", description: "QUICK", log: "" },
    },
  },
};
const layoutItem: StreamLayoutItem = {
  item,
  aboveItem: null,
  belowItem: null,
  gapBelow: 0,
  assistantSpacing: "default",
  completedFooter: null,
  toolSequence: "single",
  isFirstInUserGroup: false,
  isLastInUserGroup: false,
  isLastInToolSequence: true,
  frameOrder: "content-then-footer",
  phase: "complete",
};

describe("Arena row rendering", () => {
  it("reads child expansion through a stable render port on every row revision", () => {
    let expanded = false;
    const input = {
      item,
      layoutItemById: new Map([[item.id, layoutItem]]),
      arenaChat: true,
      renderStreamItem: () => (expanded ? "Task prompt · Ran 1 command · QUICK done" : "Completed"),
    };
    expect(renderStreamRow(input)).toBe("Completed");
    expanded = true;
    expect(renderStreamRow(input)).toBe("Task prompt · Ran 1 command · QUICK done");
    expanded = false;
    expect(renderStreamRow(input)).toBe("Completed");
    expanded = true;
    expect(renderStreamRow(input)).toBe("Task prompt · Ran 1 command · QUICK done");
  });

  it("renders a reloaded winner through the same direct port", () => {
    const reloaded = { ...item };
    const input = {
      item: reloaded,
      layoutItemById: new Map([[item.id, { ...layoutItem, item: reloaded }]]),
      arenaChat: true,
      renderStreamItem: () => "QUICK done",
    };
    expect(renderStreamRow(input)).toBe("QUICK done");
  });
});
