import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ThoughtItem, ToolCallItem } from "@/types/stream";
import type { ToolCallRun } from "@/tool-calls/detail-level/grouping";
import { arenaChatWorkLabel } from "./chat-work";

function call(id: string, detail: ToolCallDetail, name: string = detail.type): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: { provider: "opencode", callId: id, name, status: "completed", error: null, detail },
    },
  };
}
const thought: ThoughtItem = {
  kind: "thought",
  id: "t",
  text: "t",
  status: "ready",
  timestamp: new Date(0),
};
function run(items: Array<ToolCallItem | ThoughtItem>): ToolCallRun {
  const calls = items.filter((item): item is ToolCallItem => item.kind === "tool_call");
  return {
    id: "run",
    calls,
    items,
    latest: calls.at(-1) ?? (calls[0] as ToolCallItem),
    isSealed: true,
  };
}

describe("arenaChatWorkLabel", () => {
  it("names a group the way the battle pane does", () => {
    const items = [
      call("1", { type: "shell", command: "ls" }),
      call("2", { type: "read", filePath: "/a.ts" }),
      call("3", { type: "shell", command: "git status" }),
      call("4", { type: "edit", filePath: "/a.ts" }),
      call("5", { type: "search", query: "x" }, "grep"),
      thought,
    ];

    expect(arenaChatWorkLabel(run(items), false)).toBe(
      "Read 1 file · Ran 2 commands · Edited 1 file · Ran 1 search",
    );
    expect(arenaChatWorkLabel(run(items), true)).toBe(
      "Reading 1 file · Running 2 commands · Editing 1 file · Running 1 search",
    );
  });
});
