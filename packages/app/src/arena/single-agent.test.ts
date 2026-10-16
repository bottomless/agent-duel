import { describe, expect, it } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  SINGLE_AGENT_MODELS,
  singleAgentControlsLocked,
  singleAgentRatingOptional,
  singleAgentRatingRequired,
} from "./single-agent";

const frontier: NonNullable<ArenaSnapshot["singleAgent"]> = {
  id: "frontier-rating",
  modelSize: "frontier",
  ratingRequired: true,
  completed: true,
  stopped: false,
  revealed: false,
};

describe("single-agent rating gate", () => {
  it("keeps an unrated frontier result locked even when the preference changes to Medium", () => {
    expect(
      singleAgentControlsLocked({ singleAgent: frontier, modelSize: "medium", running: false }),
    ).toBe(true);
  });

  it("locks frontier while running before its snapshot arrives", () => {
    expect(
      singleAgentControlsLocked({ singleAgent: undefined, modelSize: "frontier", running: true }),
    ).toBe(true);
  });

  it("only unlocks a finished frontier result after a saved thumbs vote", () => {
    for (const vote of ["up", "down"] as const) {
      const rated = { ...frontier, vote, revealed: true };
      expect(singleAgentRatingRequired(rated)).toBe(false);
      expect(
        singleAgentControlsLocked({ singleAgent: rated, modelSize: "frontier", running: false }),
      ).toBe(false);
    }
  });

  it("offers a stopped frontier rating without locking the chat", () => {
    const stopped = { ...frontier, ratingRequired: false, stopped: true };
    expect(singleAgentRatingRequired(stopped)).toBe(false);
    expect(singleAgentRatingOptional(stopped)).toBe(true);
    expect(
      singleAgentControlsLocked({ singleAgent: stopped, modelSize: "frontier", running: false }),
    ).toBe(false);
    expect(singleAgentRatingOptional({ ...stopped, vote: "up", revealed: true })).toBe(false);
    expect(singleAgentRatingOptional(frontier)).toBe(false);
  });

  it("lets Medium continue without rating", () => {
    const medium = {
      ...frontier,
      modelSize: "medium",
      ratingRequired: false,
      revealed: true,
    } as const;
    expect(
      singleAgentControlsLocked({ singleAgent: medium, modelSize: "medium", running: false }),
    ).toBe(false);
    expect(
      singleAgentControlsLocked({ singleAgent: medium, modelSize: "medium", running: true }),
    ).toBe(false);
    expect(SINGLE_AGENT_MODELS.medium).toEqual({
      model: "arena/medium",
      thinking: "xhigh",
      label: "GPT Luna 5.6 Xhigh",
    });
  });
});
