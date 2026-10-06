import { describe, expect, it } from "vitest";
import type { ArenaRun, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaExplorerOptionId,
  arenaExplorerOptionLabel,
  parseArenaExplorerOptionId,
  resolveArenaExplorerTarget,
  selectArenaExplorerTargets,
} from "./explorer-target";

function run(input: Partial<ArenaRun> = {}): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    runState: "pending",
    durationMs: null,
    selectable: false,
    applicable: false,
    ...input,
    worktreeName: input.worktreeName ?? "a",
    worktreeActive: input.worktreeActive ?? true,
  };
}

type TurnState = NonNullable<ArenaSnapshot["turn"]>["state"];

function snapshot(input: {
  state?: TurnState;
  runs?: ArenaRun[];
  withTurn?: boolean;
}): ArenaSnapshot {
  const turn = {
    id: "turn-1",
    index: 0,
    state: input.state ?? "running",
    prompt: "make it faster",
    baseSHA: "abc",
    comparisonState: "pending" as const,
    canVote: false,
    canRetryResolution: false,
    revealed: false,
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
  };
  return {
    chat: {
      id: "chat-1",
      status: "battle_active",
      canonicalSessionID: "session-canonical",
      canonicalSHA: "abc",
      trunk: { worktreeName: "repository", branch: "main" },
    },
    environment: {},
    ...(input.withTurn === false ? {} : { turn }),
    history: [],
    runs: input.runs ?? [
      run({ id: "run-a", side: "a", worktree: "/tmp/a" }),
      run({ id: "run-b", side: "b", worktree: "/tmp/b" }),
    ],
    events: [],
  };
}

describe("selectArenaExplorerTargets", () => {
  it("offers both contestant worktrees while the turn holds them", () => {
    expect(selectArenaExplorerTargets(snapshot({ state: "running" }))).toEqual([
      { side: "a", worktree: "/tmp/a" },
      { side: "b", worktree: "/tmp/b" },
    ]);
  });

  it("keeps offering them after a failure, when looking inside matters most", () => {
    expect(selectArenaExplorerTargets(snapshot({ state: "application_failed" }))).toHaveLength(2);
  });

  it("offers nothing once cleanup has taken the worktrees", () => {
    expect(selectArenaExplorerTargets(snapshot({ state: "cleanup_pending" }))).toEqual([]);
    expect(selectArenaExplorerTargets(snapshot({ state: "complete" }))).toEqual([]);
    expect(selectArenaExplorerTargets(snapshot({ state: "discarded" }))).toEqual([]);
  });

  it("offers nothing before the worktrees exist", () => {
    expect(selectArenaExplorerTargets(snapshot({ state: "creating" }))).toEqual([]);
    expect(selectArenaExplorerTargets(snapshot({ withTurn: false }))).toEqual([]);
    expect(selectArenaExplorerTargets(undefined)).toEqual([]);
  });

  it("skips a side whose worktree path is missing", () => {
    const targets = selectArenaExplorerTargets(
      snapshot({
        runs: [
          run({ id: "run-a", side: "a", worktree: "  " }),
          run({ id: "run-b", side: "b", worktree: "/tmp/b" }),
        ],
      }),
    );
    expect(targets).toEqual([{ side: "b", worktree: "/tmp/b" }]);
  });
});

describe("arena explorer option ids", () => {
  it("round-trips a side", () => {
    expect(parseArenaExplorerOptionId(arenaExplorerOptionId("a"))).toBe("a");
    expect(parseArenaExplorerOptionId(arenaExplorerOptionId("b"))).toBe("b");
  });

  it("does not claim a branch name", () => {
    expect(parseArenaExplorerOptionId("main")).toBeNull();
    expect(parseArenaExplorerOptionId("arena-agent:c")).toBeNull();
  });

  it("labels a side the way the battle panes do", () => {
    expect(arenaExplorerOptionLabel("a")).toBe("Current agent A");
    expect(arenaExplorerOptionLabel("b")).toBe("Current agent B");
  });
});

describe("resolveArenaExplorerTarget", () => {
  const targets = [
    { side: "a" as const, worktree: "/tmp/a" },
    { side: "b" as const, worktree: "/tmp/b" },
  ];

  it("resolves a selected side to its worktree", () => {
    expect(resolveArenaExplorerTarget(targets, "b")).toEqual({ side: "b", worktree: "/tmp/b" });
  });

  it("resolves to nothing when the side is gone or unset", () => {
    expect(resolveArenaExplorerTarget(targets, null)).toBeNull();
    expect(resolveArenaExplorerTarget([], "a")).toBeNull();
  });
});
