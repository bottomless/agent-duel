import { describe, expect, it } from "vitest";
import type { ArenaRun, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaDecisionPhase,
  arenaRunningDecisionOrder,
  decisionBarShowsPhase,
  showsArenaDecisionBar,
} from "./decision-state";

type TurnState = NonNullable<ArenaSnapshot["turn"]>["state"];
type Turn = NonNullable<ArenaSnapshot["turn"]>;

function run(input: Partial<ArenaRun> = {}): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "pending",
    durationMs: null,
    selectable: false,
    applicable: false,
    ...input,
  };
}

function snapshot(input: {
  state?: TurnState;
  runs?: ArenaRun[];
  turn?: Partial<Turn> | null;
  chatStatus?: ArenaSnapshot["chat"]["status"];
  environment?: ArenaSnapshot["environment"];
}): ArenaSnapshot {
  const turn: Turn = {
    id: "turn-1",
    index: 0,
    state: input.state ?? "running",
    prompt: "make it faster",
    baseSHA: "abc",
    comparisonState: "pending",
    canVote: false,
    canRetryResolution: false,
    revealed: false,
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...input.turn,
  };
  return {
    chat: {
      id: "chat-1",
      status: input.chatStatus ?? "battle_active",
      canonicalSessionID: "session-canonical",
      canonicalSHA: "abc",
      trunk: { worktreeName: "repository", branch: "main" },
    },
    environment: input.environment ?? {},
    ...(input.turn === null ? {} : { turn }),
    history: [],
    runs: input.runs ?? [
      run({ id: "run-a", side: "a", selectable: true }),
      run({ id: "run-b", side: "b", selectable: true }),
    ],
    events: [],
  };
}

describe("showsArenaDecisionBar", () => {
  it("takes the composer slot while a battle is unresolved", () => {
    expect(showsArenaDecisionBar(snapshot({ state: "running" }))).toBe(true);
    expect(showsArenaDecisionBar(snapshot({ state: "awaiting_vote" }))).toBe(true);
    expect(showsArenaDecisionBar(snapshot({ turn: null }))).toBe(true);
  });

  it("stays while a recorded resolution can still be retried", () => {
    const retryable = snapshot({
      state: "application_failed",
      turn: { resolution: { kind: "vote", vote: "a", appliedSide: "a" }, canRetryResolution: true },
    });
    expect(showsArenaDecisionBar(retryable)).toBe(true);
  });

  it("hands the slot back once the vote is being applied", () => {
    const applying = snapshot({
      state: "applying",
      turn: { resolution: { kind: "vote", vote: "a", appliedSide: "a" } },
    });
    expect(showsArenaDecisionBar(applying)).toBe(false);
    expect(showsArenaDecisionBar(snapshot({ chatStatus: "ready" }))).toBe(false);
    expect(showsArenaDecisionBar(undefined)).toBe(false);
  });
});

describe("arenaDecisionPhase", () => {
  it("prepares while the turn has not arrived or the worktrees are being made", () => {
    expect(arenaDecisionPhase(snapshot({ turn: null }))).toEqual({
      kind: "transitional",
      label: "Preparing workspaces",
      busy: true,
    });
    expect(arenaDecisionPhase(snapshot({ state: "creating" })).kind).toBe("transitional");
    expect(arenaDecisionPhase(snapshot({ state: "worktrees_ready" })).kind).toBe("transitional");
  });

  it("offers stop and early picks while both sides are running", () => {
    const phase = arenaDecisionPhase(snapshot({ state: "running" }));
    expect(phase).toMatchObject({
      kind: "running",
      waitingFor: null,
      canStop: true,
      canPickA: true,
      canPickB: true,
    });
  });

  it("only offers an early pick for a selectable side", () => {
    const phase = arenaDecisionPhase(
      snapshot({
        state: "running",
        runs: [run({ id: "run-a", side: "a" }), run({ id: "run-b", side: "b", selectable: true })],
      }),
    );
    expect(phase).toMatchObject({ kind: "running", canPickA: false, canPickB: true });
  });

  it("offers only stop while files are still copying", () => {
    const phase = arenaDecisionPhase(
      snapshot({ state: "running", turn: { activeOperations: ["copying_environment"] } }),
    );
    expect(phase).toMatchObject({
      kind: "running",
      canStop: true,
      canPickA: false,
      canPickB: false,
    });
  });

  it("names the side still working once the other has settled", () => {
    const phase = arenaDecisionPhase(
      snapshot({
        state: "running",
        runs: [
          run({ id: "run-a", side: "a", runState: "complete", selectable: true }),
          run({ id: "run-b", side: "b", selectable: true }),
        ],
      }),
    );
    expect(phase).toMatchObject({ kind: "running", waitingFor: "b" });
  });

  it("finishes up before the vote opens", () => {
    expect(arenaDecisionPhase(snapshot({ state: "finalizing" }))).toEqual({
      kind: "transitional",
      label: "Finishing up",
      busy: true,
    });
  });

  it("opens the vote for selectable sides", () => {
    expect(
      arenaDecisionPhase(
        snapshot({
          state: "awaiting_vote",
          runs: [
            run({ id: "run-a", side: "a", runState: "complete", selectable: true }),
            run({ id: "run-b", side: "b", runState: "error" }),
          ],
        }),
      ),
    ).toEqual({ kind: "awaiting_vote", canChooseA: true, canChooseB: false });
  });

  it("waits while a stop is in flight, then asks what to keep", () => {
    expect(arenaDecisionPhase(snapshot({ state: "stopping" }))).toEqual({
      kind: "transitional",
      label: "Stopping the battle",
      busy: true,
    });
    expect(
      arenaDecisionPhase(
        snapshot({
          state: "awaiting_stop_resolution",
          runs: [
            run({ id: "run-a", side: "a", runState: "stopped", applicable: true }),
            run({ id: "run-b", side: "b", runState: "stopped" }),
          ],
        }),
      ),
    ).toEqual({ kind: "awaiting_stop_resolution", canKeepA: true, canKeepB: false });
  });

  it("surfaces a retryable resolution even though the turn is resolved", () => {
    const phase = arenaDecisionPhase(
      snapshot({
        state: "canonicalization_failed",
        turn: {
          resolution: { kind: "vote", vote: "a", appliedSide: "a" },
          canRetryResolution: true,
        },
      }),
    );
    expect(phase.kind).toBe("retry_resolution");
    expect(phase.kind === "retry_resolution" && phase.detail.length > 0).toBe(true);
  });

  it("hands the slot to the composer for every parked promotion", () => {
    // Each renders as a callout above a live composer instead, in the one place callouts live.
    for (const state of ["conflicted", "review", "manual"] as const) {
      const parked = snapshot({
        state: "application_failed",
        turn: {
          resolution: { kind: "vote", vote: "a", appliedSide: "a" },
          canRetryResolution: true,
          gitApplication: { state, conflicts: ["src/api.ts"], review: { items: [], planned: [] } },
        },
      });
      expect(showsArenaDecisionBar(parked)).toBe(false);
    }
  });

  it("keeps the ordinary retry for every other failed application", () => {
    expect(
      arenaDecisionPhase(
        snapshot({
          state: "canonicalization_failed",
          turn: {
            resolution: { kind: "vote", vote: "a", appliedSide: "a" },
            canRetryResolution: true,
            gitApplication: { state: "applied" },
          },
        }),
      ).kind,
    ).toBe("retry_resolution");
  });

  it("reports failures without a spinner and recovery with one", () => {
    expect(arenaDecisionPhase(snapshot({ state: "creation_failed" }))).toEqual({
      kind: "transitional",
      label: "Battle failed to start",
      busy: false,
    });
    expect(arenaDecisionPhase(snapshot({ state: "finalization_failed" }))).toEqual({
      kind: "transitional",
      label: "Battle failed to finish",
      busy: false,
    });
    expect(arenaDecisionPhase(snapshot({ state: "interrupted_recovery" }))).toEqual({
      kind: "transitional",
      label: "Recovering the interrupted battle",
      busy: true,
    });
  });
});

describe("arenaDecisionPhase while the next battle is prepared", () => {
  it("does not infer activity from retained services or an earlier warm-up failure", () => {
    expect(arenaDecisionPhase(snapshot({ state: "creating" }))).toEqual({
      kind: "transitional",
      label: "Preparing workspaces",
      busy: true,
    });
    expect(
      arenaDecisionPhase(
        snapshot({
          state: "creating",
          environment: {
            retainedWinner: {
              runID: "run-a",
              side: "a",
              worktreeName: "generation-1-a",
              state: "stopping",
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "transitional", label: "Preparing workspaces" });
    expect(
      arenaDecisionPhase(
        snapshot({
          turn: null,
          environment: { warmPair: { generation: 2, state: "failed", sides: [] } },
        }),
      ),
    ).toMatchObject({ kind: "transitional", label: "Preparing workspaces" });
  });
  it("reports the operations the engine is performing during setup", () => {
    expect(
      arenaDecisionPhase(
        snapshot({
          state: "creating",
          turn: { activeOperations: ["preparing_workspaces", "releasing_environment"] },
        }),
      ),
    ).toMatchObject({
      kind: "transitional",
      label: "Preparing workspaces · Releasing the previous environment",
    });
    expect(arenaDecisionPhase(snapshot({ state: "worktrees_ready" }))).toMatchObject({
      label: "Starting agents",
    });
  });
});

describe("decisionBarShowsPhase", () => {
  it("keeps the slot for resolution retries and transitions", () => {
    expect(decisionBarShowsPhase({ kind: "retry_resolution", detail: "failed" })).toBe(true);
    expect(decisionBarShowsPhase({ kind: "transitional", label: "Preparing", busy: true })).toBe(
      true,
    );
  });

  it("leaves battle actions to the floating pill", () => {
    expect(decisionBarShowsPhase(arenaDecisionPhase(snapshot({ state: "running" })))).toBe(false);
    expect(decisionBarShowsPhase(arenaDecisionPhase(snapshot({ state: "awaiting_vote" })))).toBe(
      false,
    );
    expect(
      decisionBarShowsPhase(arenaDecisionPhase(snapshot({ state: "awaiting_stop_resolution" }))),
    ).toBe(false);
  });
});

describe("arenaRunningDecisionOrder", () => {
  it.each([
    { canPickA: false, canPickB: false, expected: ["stop"] },
    { canPickA: true, canPickB: false, expected: ["a", "stop"] },
    { canPickA: false, canPickB: true, expected: ["stop", "b"] },
    { canPickA: true, canPickB: true, expected: ["a", "stop", "b"] },
  ])(
    "keeps one stop beside selectable results: A=$canPickA B=$canPickB",
    ({ canPickA, canPickB, expected }) => {
      expect(arenaRunningDecisionOrder({ canPickA, canPickB })).toEqual(expected);
    },
  );
});
