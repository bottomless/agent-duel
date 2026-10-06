import { describe, expect, it } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  ARENA_CONFLICT_RESOLUTION_PROMPT,
  arenaConflictResolutionTurnID,
  arenaSteeringQueuedMessage,
  canDrainArenaFollowUp,
  deriveArenaReplyState,
  reconcileArenaReplySelection,
} from "./reply-state";

type ArenaRunState = ArenaSnapshot["runs"][number]["runState"];

function snapshot(
  state: "running" | "awaiting_vote",
  runStates: { a: ArenaRunState; b: ArenaRunState },
): ArenaSnapshot {
  return {
    chat: {
      id: "chat-1",
      status: "battle_active",
      canonicalSessionID: "canonical-1",
      canonicalSHA: "abc123",
      trunk: { worktreeName: "repository", branch: "main" },
      activeTurnID: "turn-1",
    },
    environment: {},
    turn: {
      id: "turn-1",
      index: 1,
      state,
      prompt: "Build it",
      baseSHA: "abc123",
      comparisonState: state === "awaiting_vote" ? "complete" : "pending",
      canVote: state === "awaiting_vote",
      canRetryResolution: false,
      revealed: state === "awaiting_vote",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    history: [],
    runs: (["a", "b"] as const).map((side) => ({
      id: `run-${side}`,
      side,
      sessionID: `session-${side}`,
      descendantSessionIDs: [],
      worktree: `/tmp/${side}`,
      worktreeName: side,
      worktreeActive: true,
      runState: runStates[side],
      durationMs: 1,
      selectable: runStates[side] === "complete",
      applicable: runStates[side] === "complete",
    })),
    events: [],
  };
}

describe("deriveArenaReplyState", () => {
  it("offers steering actions while both contestants are running", () => {
    const result = deriveArenaReplyState(snapshot("running", { a: "pending", b: "pending" }));

    expect(result.replyActions).toEqual([
      { target: "a", label: "Steer A" },
      { target: "b", label: "Steer B" },
      { target: "both", label: "Steer both", isDefault: true },
    ]);
  });

  it("keeps Both, the default, while one contestant finishes before the other", () => {
    const result = deriveArenaReplyState(snapshot("running", { a: "pending", b: "complete" }));

    expect(result.replyActions).toEqual([
      { target: "a", label: "Steer A" },
      { target: "b", label: "Message B" },
      { target: "both", label: "Message both", isDefault: true },
    ]);
  });

  it("defaults to steering the contestant still working when the other cannot take a message", () => {
    const result = deriveArenaReplyState(snapshot("running", { a: "error", b: "pending" }));

    expect(result.replyActions).toEqual([{ target: "b", label: "Steer B", isDefault: true }]);
  });

  it("offers message actions after both contestants have finished", () => {
    const result = deriveArenaReplyState(
      snapshot("awaiting_vote", { a: "complete", b: "complete" }),
    );

    expect(result.replyableBattleTurn?.id).toBe("turn-1");
    expect(result.replyActions).toEqual([
      { target: "a", label: "Message A" },
      { target: "b", label: "Message B" },
      { target: "both", label: "Message both", isDefault: true },
    ]);
  });

  it("allows one next turn to queue while a recorded vote is being applied", () => {
    const applying = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    applying.turn = {
      ...applying.turn!,
      state: "cleanup_pending",
      resolution: { kind: "vote", vote: "b", appliedSide: "b" },
      vote: "b",
      appliedSide: "b",
    };

    const result = deriveArenaReplyState(applying);
    expect(result.canQueueNextTurn).toBe(true);
    expect(result.replyableBattleTurn).toBeNull();
    expect(result.replyActions).toEqual([]);
  });

  it("does not queue another turn while vote application needs recovery", () => {
    const failed = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    failed.turn = {
      ...failed.turn!,
      state: "application_failed",
      resolution: { kind: "vote", vote: "a", appliedSide: "a" },
      vote: "a",
      appliedSide: "a",
    };

    expect(deriveArenaReplyState(failed).canQueueNextTurn).toBe(false);
  });
});

describe("reconcileArenaReplySelection", () => {
  const bothRunning = deriveArenaReplyState(
    snapshot("running", { a: "pending", b: "pending" }),
  ).replyActions;
  const mixed = deriveArenaReplyState(
    snapshot("running", { a: "complete", b: "pending" }),
  ).replyActions;
  const oneFailed = deriveArenaReplyState(
    snapshot("running", { a: "error", b: "pending" }),
  ).replyActions;

  it("starts a new turn on its preferred target", () => {
    expect(reconcileArenaReplySelection(null, "turn-1", bothRunning)).toEqual({
      turnId: "turn-1",
      target: "both",
    });
    expect(reconcileArenaReplySelection(null, "turn-2", mixed)).toEqual({
      turnId: "turn-2",
      target: "both",
    });
    expect(reconcileArenaReplySelection(null, "turn-3", oneFailed)).toEqual({
      turnId: "turn-3",
      target: "b",
    });
  });

  it("keeps Both selected when one contestant finishes first", () => {
    const both = { turnId: "turn-1", target: "both" as const };
    expect(reconcileArenaReplySelection(both, "turn-1", mixed)).toBe(both);
  });

  it("clears an invalid target without redirecting the draft", () => {
    expect(
      reconcileArenaReplySelection({ turnId: "turn-1", target: "both" }, "turn-1", oneFailed),
    ).toEqual({ turnId: "turn-1", target: null });
  });

  it("keeps a cleared target empty until the user chooses again", () => {
    expect(
      reconcileArenaReplySelection({ turnId: "turn-1", target: null }, "turn-1", bothRunning),
    ).toEqual({ turnId: "turn-1", target: null });
  });

  it("keeps the target decision through a temporary reply-control gap", () => {
    const cleared = { turnId: "turn-1", target: null };
    expect(reconcileArenaReplySelection(cleared, null, [])).toBe(cleared);
    expect(reconcileArenaReplySelection(cleared, "turn-1", [])).toBe(cleared);
    expect(reconcileArenaReplySelection(cleared, "turn-1", bothRunning)).toBe(cleared);
  });

  it("resets the target for a different turn", () => {
    expect(
      reconcileArenaReplySelection({ turnId: "turn-1", target: null }, "turn-2", bothRunning),
    ).toEqual({ turnId: "turn-2", target: "both" });
  });
});

describe("canDrainArenaFollowUp", () => {
  it("waits for a ready chat without an active turn", () => {
    const ready = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    ready.chat.status = "ready";
    delete ready.chat.activeTurnID;

    expect(canDrainArenaFollowUp(ready)).toBe(true);

    ready.chat.activeTurnID = "turn-2";
    expect(canDrainArenaFollowUp(ready)).toBe(false);

    ready.chat.status = "battle_active";
    delete ready.chat.activeTurnID;
    expect(canDrainArenaFollowUp(ready)).toBe(false);
  });

  it("holds the queued battle while the trunk has conflicts", () => {
    // Conflicts keep the chat `ready`, so without the conflict check the queued battle drains
    // into the daemon's refusal and the prompt is spent on a toast.
    const conflicted = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    conflicted.chat.status = "ready";
    delete conflicted.chat.activeTurnID;
    conflicted.chat.trunkConflicts = ["src/a.ts"];

    expect(canDrainArenaFollowUp(conflicted)).toBe(false);

    conflicted.chat.trunkConflicts = [];
    expect(canDrainArenaFollowUp(conflicted)).toBe(true);
  });
});

describe("arenaConflictResolutionTurnID", () => {
  it("offers the resolution prompt after a conflicted turn completes", () => {
    const conflicted = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    conflicted.chat.status = "ready";
    delete conflicted.chat.activeTurnID;
    conflicted.history = [
      {
        id: "turn-1",
        index: 1,
        state: "complete",
        gitApplication: { state: "conflicted", conflicts: ["src/app.ts"] },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ];

    expect(arenaConflictResolutionTurnID(conflicted)).toBe("turn-1");
    expect(ARENA_CONFLICT_RESOLUTION_PROMPT).toBe("Please resolve the conflicts.");
  });

  it("does not offer the prompt for normal completion or an active next turn", () => {
    const ready = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    ready.chat.status = "ready";
    delete ready.chat.activeTurnID;
    ready.history = [
      {
        id: "turn-1",
        index: 1,
        state: "complete",
        gitApplication: { state: "applied" },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ];

    expect(arenaConflictResolutionTurnID(ready)).toBeNull();

    ready.history[0]!.gitApplication = { state: "conflicted" };
    ready.chat.status = "battle_active";
    ready.chat.activeTurnID = "turn-2";
    expect(arenaConflictResolutionTurnID(ready)).toBeNull();
  });

  it("only considers the latest completed turn", () => {
    const ready = snapshot("awaiting_vote", { a: "complete", b: "complete" });
    ready.chat.status = "ready";
    delete ready.chat.activeTurnID;
    ready.history = [
      {
        id: "turn-1",
        index: 1,
        state: "complete",
        gitApplication: { state: "conflicted" },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
      {
        id: "turn-2",
        index: 2,
        state: "complete",
        gitApplication: { state: "applied" },
        createdAt: "2026-08-14T00:02:00.000Z",
        updatedAt: "2026-08-14T00:03:00.000Z",
      },
    ];

    expect(arenaConflictResolutionTurnID(ready)).toBeNull();
  });
});

describe("arenaSteeringQueuedMessage", () => {
  it("acknowledges queued steering for one contestant", () => {
    expect(arenaSteeringQueuedMessage({ target: "a", label: "Steer A" })).toBe(
      "Steering queued for contestant A.",
    );
  });

  it("acknowledges queued steering for both contestants", () => {
    expect(arenaSteeringQueuedMessage({ target: "both", label: "Steer both" })).toBe(
      "Steering queued for both contestants.",
    );
  });

  it("does not describe a completed-result message as steering", () => {
    expect(arenaSteeringQueuedMessage({ target: "b", label: "Message B" })).toBeNull();
  });
});
