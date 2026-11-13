import { createRef, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { renderArenaStreamRow } from "./arena-stream-row";
import type { StreamLayoutItem } from "./layout";
import type { StreamViewportHandle } from "./strategy";

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

/** What the row draws inside its disclosure boundary. */
function rowContent(row: ReactNode): ReactNode {
  if (!isValidElement<{ children: ReactNode }>(row)) {
    throw new Error("Expected the row to render an element");
  }
  return row.props.children;
}

describe("Arena row rendering", () => {
  it("reads child expansion through a stable render port on every row revision", () => {
    let expanded = false;
    const input = {
      item,
      layoutItemById: new Map([[item.id, layoutItem]]),
      renderStreamItem: () => (expanded ? "Task prompt · Ran 1 command · QUICK done" : "Completed"),
      viewportRef: createRef<StreamViewportHandle>(),
    };
    expect(rowContent(renderArenaStreamRow(input))).toBe("Completed");
    expanded = true;
    expect(rowContent(renderArenaStreamRow(input))).toBe(
      "Task prompt · Ran 1 command · QUICK done",
    );
    expanded = false;
    expect(rowContent(renderArenaStreamRow(input))).toBe("Completed");
    expanded = true;
    expect(rowContent(renderArenaStreamRow(input))).toBe(
      "Task prompt · Ran 1 command · QUICK done",
    );
  });

  it("renders a reloaded winner through the same direct port", () => {
    const reloaded = { ...item };
    const input = {
      item: reloaded,
      layoutItemById: new Map([[item.id, { ...layoutItem, item: reloaded }]]),
      renderStreamItem: () => "QUICK done",
      viewportRef: createRef<StreamViewportHandle>(),
    };
    expect(rowContent(renderArenaStreamRow(input))).toBe("QUICK done");
  });
});
