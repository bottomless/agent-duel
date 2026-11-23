/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

// The decision bar these buttons come from also lays out the composer slot; the pill uses none of it.
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// The pill only reads `pending` and the callbacks; the mutations themselves are the daemon's.
vi.mock("./use-battle-actions", () => ({
  useArenaBattleActions: () => ({
    pending: false,
    pendingAction: undefined,
    choose: vi.fn(),
    pickEarly: vi.fn(),
    tie: vi.fn(),
    stop: vi.fn(),
    resolveStop: vi.fn(),
    resume: vi.fn(),
  }),
}));

import {
  ArenaDecisionBar,
  ArenaPastDecision,
  STUCK_STOPPING_DISCARD_DELAY_MS,
} from "./decision-bar";
import { ArenaDecisionPill } from "./decision-pill";

const noop = () => {};

function run(input: Partial<ArenaRun>): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "complete",
    durationMs: null,
    selectable: true,
    applicable: true,
    canRetry: false,
    ...input,
  };
}

function awaitingVote(
  runs: ArenaRun[],
  turn: { canTie: boolean; canDiscardBattle: boolean; canResumeBattle?: boolean },
): ArenaSnapshot {
  return {
    chat: {
      id: "chat-1",
      status: "battle_active",
      canonicalSessionID: "session-canonical",
      canonicalSHA: "abc",
      trunk: { worktreeName: "repository", branch: "main" },
    },
    environment: {},
    turn: {
      id: "turn-1",
      index: 0,
      state: "awaiting_vote",
      prompt: "make it faster",
      baseSHA: "abc",
      comparisonState: "complete",
      canVote: true,
      canRetryResolution: false,
      revealed: false,
      createdAt: "2026-10-14T10:00:00.000Z",
      updatedAt: "2026-10-14T10:00:00.000Z",
      canResumeBattle: false,
      ...turn,
    },
    history: [],
    runs,
    events: [],
  };
}

const failed = (side: "a" | "b", canRetry: boolean) =>
  run({
    id: `run-${side}`,
    side,
    runState: "error",
    selectable: false,
    applicable: false,
    canRetry,
  });

function choiceRowDiscard(view: ReturnType<typeof render>) {
  return within(view.getByTestId("arena-battle-choice-row")).queryByTestId("arena-stopped-discard");
}

describe("ArenaDecisionPill", () => {
  afterEach(cleanup);

  it("offers Discard alone, on the failure line, when both agents failed with no saved work", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([failed("a", true), failed("b", false)], {
          canTie: false,
          canDiscardBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Both agents failed · retry or discard")).toBeTruthy();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
    // Nothing is left to choose, so no empty pill sits under the line.
    expect(view.queryByTestId("arena-battle-choice-row")).toBeNull();
    expect(view.queryByTestId("arena-choose-tie")).toBeNull();
    // Neither failure can be voted for, so neither Choose is offered at all.
    expect(view.queryByTestId("arena-choose-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-b")).toBeNull();
    expect(view.queryByTestId("arena-accept-failed-a")).toBeNull();
    expect(view.queryByTestId("arena-accept-failed-b")).toBeNull();
  });

  it("offers Accept for each failed side with saved work, and Discard on the failure line", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote(
          [
            { ...failed("a", false), canAcceptFailed: true },
            { ...failed("b", true), canAcceptFailed: true },
          ],
          { canTie: false, canDiscardBattle: true },
        )}
        onHeightChange={noop}
      />,
    );
    expect(
      view.getByText("Both agents failed · accepting either won't count as a vote"),
    ).toBeTruthy();
    expect(view.queryByTestId("arena-accept-failed-a")).not.toBeNull();
    expect(view.queryByTestId("arena-accept-failed-b")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
    expect(choiceRowDiscard(view)).toBeNull();
    expect(view.queryByTestId("arena-choose-tie")).toBeNull();
  });

  it("drops retry from the hint once neither side can be retried", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([failed("a", false), failed("b", false)], {
          canTie: false,
          canDiscardBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Both agents failed")).toBeTruthy();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
  });

  it("offers Choose and Accept while one result can be chosen, and Discard on the failure line", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote(
          [{ ...failed("a", false), canAcceptFailed: true }, run({ id: "run-b", side: "b" })],
          { canTie: false, canDiscardBattle: true },
        )}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-choose-tie")).toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
    expect(choiceRowDiscard(view)).toBeNull();
    expect(view.queryByText(/Both agents failed/)).toBeNull();
    // The voter learns first that neither choice counts.
    expect(view.getByText("Agent A failed · choosing either won't count as a vote")).toBeTruthy();
    expect(view.queryByTestId("arena-accept-failed-a")).not.toBeNull();
    expect(view.queryByTestId("arena-choose-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-b")).not.toBeNull();
  });

  it("leaves out a failed side whose result was not saved", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([failed("a", false), run({ id: "run-b", side: "b" })], {
          canTie: false,
          canDiscardBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Agent A failed · choosing B won't count as a vote")).toBeTruthy();
    expect(view.getByTestId("arena-stopped-discard").textContent).toContain("Discard battle");
    expect(view.queryByTestId("arena-accept-failed-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-b")).not.toBeNull();
  });

  it("offers Tie and no Discard when both sides finished", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([run({ id: "run-a", side: "a" }), run({ id: "run-b", side: "b" })], {
          canTie: true,
          canDiscardBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-choose-a")).not.toBeNull();
    expect(view.queryByTestId("arena-choose-tie")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).toBeNull();
    expect(view.queryByTestId("arena-choose-b")).not.toBeNull();
  });

  const interrupted = (side: "a" | "b") =>
    run({
      id: `run-${side}`,
      side,
      runState: "interrupted",
      selectable: false,
      applicable: false,
    });

  it("offers only Resume and Discard when the restart cut off both agents", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([interrupted("a"), interrupted("b")], {
          canTie: false,
          canDiscardBattle: true,
          canResumeBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Agent Duel closed during the battle · resume or discard")).toBeTruthy();
    expect(view.queryByTestId("arena-resume-interrupted")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
    expect(view.queryByTestId("arena-choose-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-b")).toBeNull();
    expect(view.queryByText(/Both agents failed/)).toBeNull();
  });

  it("offers no choice of the side that finished before the restart", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([run({ id: "run-a", side: "a" }), interrupted("b")], {
          canTie: false,
          canDiscardBattle: true,
          canResumeBattle: true,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Agent Duel closed during the battle · resume or discard")).toBeTruthy();
    expect(view.queryByTestId("arena-resume-interrupted")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
    expect(view.queryByTestId("arena-choose-a")).toBeNull();
    expect(view.queryByTestId("arena-choose-tie")).toBeNull();
  });

  it("says first that choosing either side after a failure will not count", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={STOPPED_AFTER_FAILURE}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Agent A failed · choosing either won't count as a vote")).toBeTruthy();
    // After a stop the sides read as at the vote: Choose, or Accept for the side that failed.
    expect(view.getByTestId("arena-stopped-choose-b").textContent).toBe("Choose B");
    expect(view.queryByText(/Keep/)).toBeNull();
    // After a stop Discard is one of the pill's three choices, not a row action.
    expect(choiceRowDiscard(view)).not.toBeNull();
    expect(choiceRowDiscard(view)?.textContent).not.toContain("Discard battle");
  });
});

describe("a failed side after a stop", () => {
  it("offers Accept, as at the vote, when its work can be applied", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={STOPPED_WITH_ACCEPTABLE_FAILURE}
        onHeightChange={noop}
      />,
    );
    expect(view.getByTestId("arena-stopped-choose-a").textContent).toBe("Accept A");
    expect(view.getByTestId("arena-stopped-choose-b").textContent).toBe("Choose B");
    view.unmount();
  });
});

const STOPPED_WITH_ACCEPTABLE_FAILURE: ArenaSnapshot = (() => {
  const snapshot = awaitingVote(
    [
      run({ id: "run-a", side: "a", runState: "error", selectable: false, applicable: true }),
      run({ id: "run-b", side: "b", runState: "stopped", selectable: false, applicable: true }),
    ],
    { canTie: false, canDiscardBattle: true },
  );
  return { ...snapshot, turn: { ...snapshot.turn!, state: "awaiting_stop_resolution" } };
})();

const STOPPED_AFTER_FAILURE: ArenaSnapshot = (() => {
  const snapshot = awaitingVote(
    [
      failed("a", false),
      run({ id: "run-b", side: "b", runState: "stopped", selectable: false, applicable: true }),
    ],
    { canTie: false, canDiscardBattle: true },
  );
  return { ...snapshot, turn: { ...snapshot.turn!, state: "awaiting_stop_resolution" } };
})();

describe("the decision just made", () => {
  const runs = [run({}), run({ id: "run-b", side: "b" })];
  const voting = awaitingVote(runs, { canTie: true, canDiscardBattle: false });
  const identities = {
    a: { name: "GLM 5.3 FlashX" },
    b: { name: "Qwen 3.8 Max" },
  };
  const voted = (state: string, chatStatus: "battle_active" | "ready"): ArenaSnapshot => ({
    ...voting,
    chat: { ...voting.chat, status: chatStatus },
    turn: {
      ...voting.turn!,
      state,
      vote: "b",
      resolution: { kind: "vote", vote: "b", appliedSide: "b" },
      identities,
      revealed: true,
    } as ArenaSnapshot["turn"],
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("names the models and marks the choice while it applies, and at least five seconds", () => {
    vi.useFakeTimers();
    const view = render(
      <ArenaDecisionPill serverId="s" agentId="agent" snapshot={voting} onHeightChange={noop} />,
    );
    view.rerender(
      <ArenaDecisionPill
        serverId="s"
        agentId="agent"
        snapshot={voted("applying", "battle_active")}
        onHeightChange={noop}
      />,
    );
    const decided = view.getByTestId("arena-past-decision");
    expect(decided.textContent).toContain("GLM 5.3 FlashX");
    expect(decided.textContent).toContain("Qwen 3.8 Max");
    expect(view.getByTestId("arena-past-decision-b-chosen").textContent).toContain("Qwen 3.8 Max");

    // Applied within a second: the chat is ready, but the result stays for the full hold.
    view.rerender(
      <ArenaDecisionPill
        serverId="s"
        agentId="agent"
        snapshot={voted("complete", "ready")}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-past-decision")).not.toBeNull();
    React.act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(view.queryByTestId("arena-decision-pill")).toBeNull();
  });

  it("stays past five seconds while the result is still being applied", () => {
    vi.useFakeTimers();
    const view = render(
      <ArenaDecisionPill serverId="s" agentId="agent" snapshot={voting} onHeightChange={noop} />,
    );
    view.rerender(
      <ArenaDecisionPill
        serverId="s"
        agentId="agent"
        snapshot={voted("applying", "battle_active")}
        onHeightChange={noop}
      />,
    );
    React.act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(view.queryByTestId("arena-past-decision")).not.toBeNull();
    view.rerender(
      <ArenaDecisionPill
        serverId="s"
        agentId="agent"
        snapshot={voted("complete", "ready")}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-decision-pill")).toBeNull();
  });

  it("holds nothing for a battle decided before the chat was opened", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="s"
        agentId="agent"
        snapshot={voted("complete", "ready")}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-decision-pill")).toBeNull();
  });
});

describe("ArenaPastDecision", () => {
  it("draws a taken Tie or Discard in the foreground, not the browser's default black", () => {
    for (const kind of ["vote", "stop"] as const) {
      const view = render(<ArenaPastDecision kind={kind} chosen="middle" />);
      const taken = within(view.getByTestId("arena-past-decision-middle-chosen")).getByText(
        kind === "vote" ? "Tie" : "Discard",
      );
      const side = within(view.getByTestId("arena-past-decision-a")).getByText("Choose A");
      expect(taken.style.color).not.toBe("");
      expect(taken.style.color).toBe(side.style.color);
      view.unmount();
    }
  });
});

describe("ArenaDecisionBar stuck stopping discard", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function stoppingSnapshot(stoppingAt: string): ArenaSnapshot {
    const base = awaitingVote(
      [
        run({ id: "run-a", side: "a", runState: "complete", selectable: true }),
        run({ id: "run-b", side: "b", runState: "pending", selectable: false, applicable: false }),
      ],
      { canTie: false, canDiscardBattle: true },
    );
    return {
      ...base,
      turn: {
        ...base.turn!,
        state: "stopping",
        stoppingAt,
      },
    };
  }

  it("hides Discard during a fresh stop and offers it once stopping takes too long", () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-14T10:00:00.000Z");
    vi.setSystemTime(now);

    const view = render(
      <ArenaDecisionBar
        serverId="server"
        agentId="agent"
        snapshot={stoppingSnapshot(now.toISOString())}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-decision-transitional")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).toBeNull();

    React.act(() => {
      vi.advanceTimersByTime(STUCK_STOPPING_DISCARD_DELAY_MS - 1);
    });
    expect(view.queryByTestId("arena-stopped-discard")).toBeNull();

    React.act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
  });

  it("offers Discard immediately when reopening a battle already stuck in stopping", () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-14T10:01:00.000Z");
    vi.setSystemTime(now);

    const view = render(
      <ArenaDecisionBar
        serverId="server"
        agentId="agent"
        snapshot={stoppingSnapshot(
          new Date(now.getTime() - STUCK_STOPPING_DISCARD_DELAY_MS).toISOString(),
        )}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-stopped-discard")).not.toBeNull();
  });
});
