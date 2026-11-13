/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

import { ArenaBattleResult, ArenaTurnHead } from "./turn-head";
import { useArenaShownBattleStore } from "./shown-battle";

const kept = (over: Partial<ArenaHistoryItem>) =>
  ({
    id: "turn-1",
    index: 0,
    state: "complete",
    identities: { a: { name: "GPT-6.1 Sol" }, b: { name: "Claude Opus 5.5" } },
    ...over,
  }) as unknown as ArenaHistoryItem;

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

  it("tags a tie and an early pick for what they were, and any other kept side as won", () => {
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

    // Kept at a Stop: no vote at all.
    const stopped = render(<ArenaBattleResult agentId="agent" item={kept({ appliedSide: "a" })} />);
    expect(stopped.getByTestId("arena-battle-result-tag-won").textContent).toBe("Won");
    expect(stopped.getByTestId("arena-battle-result-turn-1").textContent).not.toContain(
      "Vote not counted",
    );
  });
});
