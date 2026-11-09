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

// The review pinned above the row fetches its own diff; these tests are about the choices.
vi.mock("./battle-judging", () => ({
  ArenaPinnedReview: () => null,
  arenaBattleHasReview: () => false,
}));

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

  it("says first that keeping either side after a failure will not count", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={STOPPED_AFTER_FAILURE}
        onHeightChange={noop}
      />,
    );
    expect(view.getByText("Agent A failed · keeping either won't count as a vote")).toBeTruthy();
    expect(view.queryByTestId("arena-stopped-keep-b")).not.toBeNull();
    // After a stop Discard is one of the pill's three choices, not a row action.
    expect(choiceRowDiscard(view)).not.toBeNull();
    expect(choiceRowDiscard(view)?.textContent).not.toContain("Discard battle");
  });
});

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
