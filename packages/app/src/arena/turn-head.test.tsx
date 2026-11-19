/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

import {
  ArenaBattleResult,
  ArenaTurnHead,
  arenaColumnResult,
  type ArenaSingleAgentTurn,
} from "./turn-head";
import { useArenaShownBattleStore } from "./shown-battle";

const kept = (over: Partial<ArenaHistoryItem>) =>
  ({
    id: "turn-1",
    index: 0,
    state: "complete",
    identities: { a: { name: "GPT-6.1 Sol" }, b: { name: "Claude Opus 5.5" } },
    ...over,
  }) as unknown as ArenaHistoryItem;

const MEDIUM_TURN: ArenaSingleAgentTurn = {
  messageID: "msg_1",
  modelSize: "medium",
  identity: { name: "GPT Luna 5.6 Xhigh" },
};
const UNRATED_FRONTIER_TURN: ArenaSingleAgentTurn = { messageID: "msg_2", modelSize: "frontier" };
const RATED_FRONTIER_TURN: ArenaSingleAgentTurn = {
  messageID: "msg_3",
  modelSize: "frontier",
  identity: { name: "Claude Opus 5.5" },
};

afterEach(() => {
  cleanup();
  useArenaShownBattleStore.setState({ byAgent: {} });
});

describe("ArenaTurnHead", () => {
  it("names only the winner above its answer", () => {
    const view = render(<ArenaTurnHead item={kept({ vote: "b", appliedSide: "b" })} />);
    expect(view.getByTestId("arena-turn-head-turn-1").textContent).toBe("Claude Opus 5.5");
  });

  it("heads a plain turn with the agent", () => {
    const view = render(<ArenaTurnHead />);
    expect(view.getByTestId("arena-turn-head-agent").textContent).toBe("Agent");
  });

  it("heads a single-agent turn with its model, and an unrated frontier turn with Frontier", () => {
    const medium = render(<ArenaTurnHead singleAgent={MEDIUM_TURN} />);
    expect(medium.getByTestId("arena-turn-head-msg_1").textContent).toBe("GPT Luna 5.6 Xhigh");
    medium.unmount();

    const unrated = render(<ArenaTurnHead singleAgent={UNRATED_FRONTIER_TURN} />);
    expect(unrated.getByTestId("arena-turn-head-agent").textContent).toBe("Frontier");
    unrated.unmount();

    const rated = render(<ArenaTurnHead singleAgent={RATED_FRONTIER_TURN} />);
    expect(rated.getByTestId("arena-turn-head-msg_3").textContent).toBe("Claude Opus 5.5");
  });
});

describe("ArenaBattleResult", () => {
  it("names the winner, tags it Won, names who it beat and opens the battle", () => {
    const view = render(
      <ArenaBattleResult agentId="agent" item={kept({ vote: "b", appliedSide: "b" })} />,
    );
    expect(view.getByTestId("arena-battle-result-turn-1").textContent).toContain("Claude Opus 5.5");
    expect(view.getByTestId("arena-battle-result-tag-won").textContent).toBe("Won");
    expect(view.getByTestId("arena-battle-result-opponent-turn-1").textContent).toBe("GPT-6.1 Sol");
    fireEvent.click(view.getByTestId("arena-show-battle-turn-1"));
    expect(useArenaShownBattleStore.getState().byAgent.agent).toBe("turn-1");
  });

  it("heads a tie with its tag, names both models alike and says whose changes stayed", () => {
    const view = render(
      <ArenaBattleResult agentId="agent" item={kept({ vote: "tie", appliedSide: "a" })} />,
    );
    expect(view.getByTestId("arena-battle-result-turn-1").textContent).toBe(
      "TieGPT-6.1 SolvsClaude Opus 5.5·A's changes applied·Show battle›",
    );
  });

  it("tags a tie, an early pick and a side kept at a Stop for what they were, and any other kept side as won", () => {
    const tie = render(
      <ArenaBattleResult agentId="agent" item={kept({ vote: "tie", appliedSide: "a" })} />,
    );
    expect(tie.getByTestId("arena-battle-result-turn-1").textContent).toContain("GPT-6.1 Sol");
    expect(tie.getByTestId("arena-battle-result-tag-tie").textContent).toBe("Tie");
    tie.unmount();

    const early = render(
      <ArenaBattleResult
        agentId="agent"
        item={kept({ vote: "b", appliedSide: "b", selectedEarly: true })}
      />,
    );
    expect(early.getByTestId("arena-battle-result-tag-early")).toBeTruthy();
    early.unmount();

    const failed = render(
      <ArenaBattleResult
        agentId="agent"
        item={kept({ vote: "a", appliedSide: "a", voteDiscardedReason: "contestant_failed" })}
      />,
    );
    expect(failed.getByTestId("arena-battle-result-tag-won").textContent).toBe("Won");
    expect(failed.getByTestId("arena-battle-result-turn-1").textContent).toContain(
      "Vote not counted",
    );
    failed.unmount();

    // Chosen at a Stop: no vote at all, yet it reads as a win, as at the vote.
    const stopped = render(
      <ArenaBattleResult
        agentId="agent"
        item={kept({
          appliedSide: "a",
          resolution: { kind: "stopped", resolution: "apply_a", appliedSide: "a" },
        })}
      />,
    );
    expect(stopped.getByTestId("arena-battle-result-tag-won").textContent).toBe("Won");
    expect(stopped.getByTestId("arena-battle-result-turn-1").textContent).toMatch(
      /^GPT-6\.1 SolWonvs/,
    );
    expect(stopped.getByTestId("arena-battle-result-turn-1").textContent).not.toContain(
      "Vote not counted",
    );
  });
});

describe("arenaColumnResult", () => {
  const both = (item: ArenaHistoryItem) => [
    arenaColumnResult(item, "a"),
    arenaColumnResult(item, "b"),
  ];

  it("tags only the chosen column with how it was chosen, a side chosen at a Stop as won", () => {
    expect(both(kept({ vote: "b", appliedSide: "b" }))).toEqual([undefined, "won"]);
    expect(both(kept({ vote: "a", appliedSide: "a", selectedEarly: true }))).toEqual([
      "early",
      undefined,
    ]);
    expect(
      both(kept({ appliedSide: "a", resolution: { kind: "stopped", resolution: "apply_a" } })),
    ).toEqual(["won", undefined]);
  });

  it("tags both columns of a tie, so neither reads as the winner", () => {
    expect(both(kept({ vote: "tie", appliedSide: "a" }))).toEqual(["tie", "tie"]);
  });

  it("tags neither column when nothing was kept", () => {
    expect(both(kept({ resolution: { kind: "stopped", resolution: "discard" } }))).toEqual([
      undefined,
      undefined,
    ]);
  });
});
