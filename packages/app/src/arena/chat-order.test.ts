import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { orderArenaChat } from "./chat-order";

function call(id: string, detail: ToolCallDetail = { type: "shell", command: id }): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "opencode",
        callId: id,
        name: detail.type,
        status: "completed",
        error: null,
        detail,
      },
    },
  };
}
const thought = (id: string): StreamItem => ({
  kind: "thought",
  id,
  text: id,
  status: "ready",
  timestamp: new Date(0),
});
const text = (id: string): StreamItem => ({
  kind: "assistant_message",
  id,
  text: id,
  timestamp: new Date(0),
});
const user = (id: string): StreamItem => ({
  kind: "user_message",
  id,
  text: id,
  timestamp: new Date(0),
});
const ids = (items: StreamItem[]) => items.map((item) => item.id);

describe("orderArenaChat", () => {
  it("moves a turn's work before its first text beneath that text", () => {
    const items = [
      user("u1"),
      thought("r1"),
      call("read"),
      call("read2"),
      text("t1"),
      call("ls"),
      text("t2"),
    ];

    expect(ids(orderArenaChat(items))).toEqual(["u1", "t1", "r1", "read", "read2", "ls", "t2"]);
  });

  it("orders each turn on its own", () => {
    const items = [user("u1"), call("a"), text("t1"), user("u2"), call("b"), text("t2")];

    expect(ids(orderArenaChat(items))).toEqual(["u1", "t1", "a", "u2", "t2", "b"]);
  });

  it("leaves work in place when the turn writes no text", () => {
    const items = [user("u1"), call("a"), thought("r1"), user("u2"), text("t2")];

    expect(orderArenaChat(items)).toBe(items);
  });

  it("keeps work above a question or checklist that comes before the first text", () => {
    const todo: StreamItem = {
      kind: "todo_list",
      id: "todo",
      provider: "opencode",
      items: [],
      activity: { type: "created", count: 0 },
      timestamp: new Date(0),
    };
    const items = [user("u1"), call("a"), todo, call("b"), text("t1")];

    expect(ids(orderArenaChat(items))).toEqual(["u1", "a", "todo", "t1", "b"]);
  });

  it("returns the same list when nothing moves", () => {
    const items = [user("u1"), text("t1"), call("a"), text("t2")];

    expect(orderArenaChat(items)).toBe(items);
  });

  it("keeps a subagent where it was, with the work after it, as the pane's own row", () => {
    const subagent = call("task", {
      type: "sub_agent",
      description: "Read files",
      childSessionId: "ses_child",
      log: "",
    });
    const items = [
      user("u1"),
      thought("r1"),
      subagent,
      call("ls"),
      text("t1"),
      call("cat"),
      text("t2"),
    ];

    expect(ids(orderArenaChat(items))).toEqual(["u1", "r1", "task", "ls", "t1", "cat", "t2"]);
  });
});
