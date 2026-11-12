/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

import { ArenaTurnHead } from "./turn-head";
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
  it("names the winner, tags it Won and names who it beat", () => {
    const view = render(
      <ArenaTurnHead agentId="agent" item={kept({ vote: "b", appliedSide: "b" })} />,
    );
    const head = view.getByTestId("arena-turn-head-turn-1");
    expect(head.textContent).toContain("Claude Opus 5.5");
    expect(view.getByTestId("arena-turn-head-result-won").textContent).toBe("Won");
    expect(view.getByTestId("arena-turn-head-opponent-turn-1").textContent).toBe("vs GPT-6.1 Sol");
    fireEvent.click(view.getByTestId("arena-show-battle-turn-1"));
    expect(useArenaShownBattleStore.getState().byAgent.agent).toBe("turn-1");
  });

  it("tags a tie, an early pick and a side kept after a failure for what they were", () => {
    const tie = render(
      <ArenaTurnHead agentId="agent" item={kept({ vote: "tie", appliedSide: "a" })} />,
    );
    expect(tie.getByTestId("arena-turn-head-turn-1").textContent).toContain("GPT-6.1 Sol");
    expect(tie.getByTestId("arena-turn-head-result-tie").textContent).toBe("Tie");
    tie.unmount();

    const early = render(
      <ArenaTurnHead
        agentId="agent"
        item={kept({ vote: "b", appliedSide: "b", selectedEarly: true })}
      />,
    );
    expect(early.getByTestId("arena-turn-head-result-early")).toBeTruthy();
    early.unmount();

    const failed = render(
      <ArenaTurnHead
        agentId="agent"
        item={kept({ vote: "a", appliedSide: "a", voteDiscardedReason: "contestant_failed" })}
      />,
    );
    expect(failed.getByTestId("arena-turn-head-result-kept")).toBeTruthy();
    expect(failed.getByTestId("arena-turn-head-turn-1").textContent).toContain("Vote not counted");
  });

  it("heads a plain turn with the agent", () => {
    const view = render(<ArenaTurnHead agentId="agent" />);
    expect(view.getByTestId("arena-turn-head-agent").textContent).toBe("Agent");
  });
});
