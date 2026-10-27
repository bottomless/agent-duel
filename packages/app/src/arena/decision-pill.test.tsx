/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

const testMocks = vi.hoisted(() => ({
  actions: {
    pending: false,
    pendingAction: undefined,
    choose: vi.fn(),
    pickEarly: vi.fn(),
    tie: vi.fn(),
    stop: vi.fn(),
    resolveStop: vi.fn(),
    resume: vi.fn(),
  },
  voteEvidence: vi.fn(async () => ({ activation: "script" as const })),
}));

// The decision bar these buttons come from also lays out the composer slot; the pill uses none of it.
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// The pill only reads `pending` and the callbacks; the mutations themselves are the daemon's.
vi.mock("./use-battle-actions", () => ({
  useArenaBattleActions: () => testMocks.actions,
}));

vi.mock("./vote-evidence", () => ({
  voteEvidence: testMocks.voteEvidence,
}));

// No daemon serves a vote frame here, so every button takes its own click.
vi.mock("./vote-frame", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vote-frame")>()),
  useVoteFrameUrl: () => null,
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

describe("ArenaDecisionPill", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers Discard in Tie's place when both agents failed", () => {
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

  it("keeps Tie without Discard while one result can be chosen", () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([failed("a", false), run({ id: "run-b", side: "b" })], {
          canTie: false,
          canDiscardBattle: false,
        })}
        onHeightChange={noop}
      />,
    );
    expect(view.queryByTestId("arena-choose-tie")).not.toBeNull();
    expect(view.queryByTestId("arena-stopped-discard")).toBeNull();
    expect(view.queryByText(/Both agents failed/)).toBeNull();
  });

  it("passes the evidence from a side choice to the action", async () => {
    const view = render(
      <ArenaDecisionPill
        serverId="server"
        agentId="agent"
        snapshot={awaitingVote([run({ id: "run-a", side: "a" }), run({ id: "run-b", side: "b" })], {
          canTie: false,
          canDiscardBattle: false,
        })}
        onHeightChange={noop}
      />,
    );

    fireEvent.click(view.getByTestId("arena-choose-a"));

    await waitFor(() => {
      expect(testMocks.voteEvidence).toHaveBeenCalledTimes(1);
      expect(testMocks.actions.choose).toHaveBeenCalledWith("a", {
        evidence: { activation: "script" },
      });
    });
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
});
