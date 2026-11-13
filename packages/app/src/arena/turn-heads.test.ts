import { describe, expect, it } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";
import type { StreamItem } from "@/types/stream";
import { arenaTurnHeads } from "./turn-heads";

const battle = (id: string, first: string, last?: string, vote = "b") =>
  ({
    id,
    index: 1,
    state: "complete",
    vote,
    appliedSide: vote === "tie" ? "a" : vote,
    canonicalUserMessageID: first,
    ...(last ? { canonicalLastMessageID: last } : {}),
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:01:00.000Z",
  }) as unknown as ArenaHistoryItem;

const prompt = (id: string) => ({ id, kind: "user_message", messageId: id }) as StreamItem;
const text = (id: string) => ({ id, kind: "assistant_message" }) as StreamItem;
const thought = (id: string) => ({ id, kind: "thought", status: "ready", text: "t" }) as StreamItem;

describe("arenaTurnHeads", () => {
  it("opens every answer with its author: the agent for a plain turn, the battle for a kept one", () => {
    const tail = [
      prompt("msg_0010"),
      text("a1"),
      prompt("msg_0100"),
      thought("t2"),
      text("a2"),
      prompt("msg_0200"),
      text("a3"),
    ];
    const kept = battle("turn-2", "msg_0100");
    const { heads, answerRowIds, ends } = arenaTurnHeads([kept], { tail, head: [] });
    expect([...heads.entries()]).toEqual([
      ["a1", { kind: "agent" }],
      // The chat sets work under the text it led into (`orderArenaChat`), so the text opens it.
      ["a2", { kind: "battle", item: kept }],
      ["a3", { kind: "agent" }],
    ]);
    expect([...answerRowIds]).toEqual(["a1", "a2", "t2", "a3"]);
    // The battle's result ends the footer of its answer's last text.
    expect([...ends.entries()]).toEqual([["a2", kept]]);
  });

  it("keeps replies sent inside a battle in that battle's one answer", () => {
    const tail = [
      prompt("msg_0100"),
      text("a1"),
      prompt("msg_0120"),
      text("a2"),
      prompt("msg_0300"),
      text("later"),
    ];
    const kept = battle("turn-1", "msg_0100", "msg_0199");
    const { heads, ends } = arenaTurnHeads([kept], { tail, head: [] });
    expect([...heads.keys()]).toEqual(["a1", "later"]);
    // One result, after the last reply the battle answered.
    expect([...ends.keys()]).toEqual(["a2"]);
  });

  it("gives no head to an answer whose prompt has not loaded yet", () => {
    // The chat's loaded page starts partway through a battle's answer.
    const tail = [thought("t0"), text("a0"), prompt("msg_0200"), text("a2")];
    const { heads, answerRowIds } = arenaTurnHeads([battle("turn-1", "msg_0100")], {
      tail,
      head: [],
    });
    expect([...heads.entries()]).toEqual([["a2", { kind: "agent" }]]);
    expect(answerRowIds.has("a0")).toBe(true);
  });

  it("opens nothing for a battle that kept no answer", () => {
    const discarded = {
      ...battle("turn-1", "msg_0100"),
      vote: undefined,
      appliedSide: undefined,
    } as unknown as ArenaHistoryItem;
    const tail = [prompt("msg_0100"), prompt("msg_0200"), text("a2")];
    const { heads } = arenaTurnHeads([discarded], { tail, head: [] });
    expect([...heads.entries()]).toEqual([["a2", { kind: "agent" }]]);
  });
});
