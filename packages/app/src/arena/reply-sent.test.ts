import { describe, expect, it, vi } from "vitest";
import {
  announceArenaReplySent,
  arenaReplyAnswered,
  arenaReplyReaches,
  subscribeArenaReplySent,
} from "./reply-sent";

describe("announceArenaReplySent", () => {
  it("tells the panes of that battle who the reply went to", () => {
    const pane = vi.fn();
    const otherBattle = vi.fn();
    const unsubscribe = subscribeArenaReplySent("turn-1", pane);
    const unsubscribeOther = subscribeArenaReplySent("turn-2", otherBattle);

    announceArenaReplySent("turn-1", "a");

    expect(pane).toHaveBeenCalledWith("a");
    expect(otherBattle).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribeOther();
  });

  it("stops telling a pane that has gone", () => {
    const pane = vi.fn();
    subscribeArenaReplySent("turn-1", pane)();

    announceArenaReplySent("turn-1", "both");

    expect(pane).not.toHaveBeenCalled();
  });
});

describe("arenaReplyAnswered", () => {
  it("waits for every run the reply went to and ignores the other", () => {
    expect(arenaReplyAnswered("both", { a: true, b: false })).toBe(false);
    expect(arenaReplyAnswered("both", { a: true, b: true })).toBe(true);
    expect(arenaReplyAnswered("a", { a: true, b: false })).toBe(true);
    expect(arenaReplyAnswered("b", { a: true, b: false })).toBe(false);
  });
});

describe("arenaReplyReaches", () => {
  it("reaches both panes for a reply to both and one pane for a reply to a side", () => {
    expect(arenaReplyReaches("both", "a")).toBe(true);
    expect(arenaReplyReaches("both", "b")).toBe(true);
    expect(arenaReplyReaches("a", "a")).toBe(true);
    expect(arenaReplyReaches("a", "b")).toBe(false);
  });
});
