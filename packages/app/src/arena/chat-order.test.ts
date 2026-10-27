import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { arenaChatPendingWorkStart, orderArenaChat, orderArenaChatHead } from "./chat-order";

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

describe("orderArenaChatHead", () => {
  /** The tail and head as the chat renders them, joined in screen order. */
  const rendered = (tail: StreamItem[], head: StreamItem[]) => {
    const ordered = orderArenaChat(tail);
    const start = arenaChatPendingWorkStart(ordered);
    const orderedHead = orderArenaChatHead(ordered.slice(start), head);
    return orderedHead ? [...ordered.slice(0, start), ...orderedHead] : [...ordered, ...head];
  };

  it("moves the tail's leading work beneath a text that is still in the head", () => {
    // The winner's answer stays in the head after the vote: no turn completion commits it.
    const tail = [user("u1"), call("read"), thought("r1"), call("ls")];
    const head = [text("t1")];

    expect(ids(rendered(tail, head))).toEqual(["u1", "t1", "read", "r1", "ls"]);
    expect(ids(rendered(tail, head))).toEqual(ids(orderArenaChat([...tail, ...head])));
  });

  it("leaves both lanes alone when the head has no text yet", () => {
    const tail = [user("u1"), call("read")];
    const head = [thought("r1")];
    const ordered = orderArenaChat(tail);

    expect(orderArenaChatHead(ordered.slice(arenaChatPendingWorkStart(ordered)), head)).toBeNull();
  });

  it("pulls nothing once the turn has written text", () => {
    const tail = orderArenaChat([user("u1"), call("read"), text("t1"), call("ls")]);

    expect(arenaChatPendingWorkStart(tail)).toBe(tail.length);
    expect(ids(rendered([user("u1"), call("read"), text("t1"), call("ls")], [text("t2")]))).toEqual(
      ["u1", "t1", "read", "ls", "t2"],
    );
  });

  it("keeps an earlier turn's work where it was when the head starts a new turn", () => {
    const tail = [user("u1"), call("read")];
    const head = [user("u2"), text("t2")];

    expect(ids(rendered(tail, head))).toEqual(["u1", "read", "u2", "t2"]);
  });

  it("pulls no work across a subagent the turn already showed", () => {
    const subagent = call("task", {
      type: "sub_agent",
      description: "Look around",
      childSessionId: "ses_child",
      log: "",
    });
    const tail = [user("u1"), subagent, call("ls")];

    expect(arenaChatPendingWorkStart(orderArenaChat(tail))).toBe(tail.length);
  });
});
