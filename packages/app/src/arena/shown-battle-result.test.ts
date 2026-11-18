import { describe, expect, it } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";
import { shownBattleResult } from "./shown-battle-result";

const identities = { a: { name: "Claude Opus" }, b: { name: "Qwen 3.8 Max" } };
const item = (fields: Partial<ArenaHistoryItem>) =>
  ({ id: "turn-1", index: 0, state: "complete", identities, ...fields }) as ArenaHistoryItem;

describe("shownBattleResult", () => {
  it("states a vote as the side chosen and its model", () => {
    expect(
      shownBattleResult(item({ resolution: { kind: "vote", vote: "b", appliedSide: "b" } })),
    ).toEqual({
      statement: { key: "arena.youChoseSide", side: "b" },
      check: "b",
      model: "Qwen 3.8 Max",
      notes: [],
    });
  });

  it("states a tie with the side whose changes were kept", () => {
    expect(
      shownBattleResult(item({ resolution: { kind: "vote", vote: "tie", appliedSide: "a" } })),
    ).toEqual({
      statement: { key: "arena.youCalledTie" },
      check: "tie",
      tieKept: "a",
      model: "Claude Opus",
      notes: [],
    });
  });

  it("states an early pick, a side kept at a Stop, and a discard", () => {
    expect(
      shownBattleResult(item({ resolution: { kind: "early", vote: "a", appliedSide: "a" } }))
        ?.statement,
    ).toEqual({ key: "arena.youChoseSideEarly", side: "a" });
    expect(
      shownBattleResult(item({ resolution: { kind: "stopped", resolution: "apply_b" } })),
    ).toEqual({
      lead: { key: "arena.battleStopped" },
      statement: { key: "arena.youKeptSide", side: "b" },
      model: "Qwen 3.8 Max",
      notes: [],
    });
    expect(
      shownBattleResult(item({ resolution: { kind: "stopped", resolution: "discard" } })),
    ).toEqual({ statement: { key: "arena.battleDiscarded" }, notes: [] });
  });

  it("leaves the model out before the reveal and notes an uncounted vote", () => {
    const result = shownBattleResult(
      item({
        identities: undefined,
        voteDiscardedReason: "contestant_failed",
        resolution: { kind: "vote", vote: "a", appliedSide: "a" },
      }),
    );
    expect(result?.model).toBeUndefined();
    expect(result?.notes).toEqual(["arena.voteNotCounted"]);
  });

  it("has nothing to state for a battle that ended without a decision", () => {
    expect(shownBattleResult(item({ resolution: { kind: "aborted", reason: "x" } }))).toBeNull();
  });
});
