import { describe, expect, it } from "vitest";
import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaTurnLabel,
  planArenaTerminalTransition,
  resolveArenaSeatMenuSides,
  resolveArenaSeatTerminalSides,
  resolveArenaTerminalTarget,
  type ArenaTerminalTarget,
} from "./terminal-target";

function snapshot(input: {
  turnIndex?: number;
  state?: string;
  runs: Array<{ side: ArenaSide; worktree: string; worktreeActive?: boolean }>;
  /** Turns this chat has already finished. A battle chat with no turn in flight still has these. */
  history?: number;
  turn?: false;
}): ArenaSnapshot {
  return {
    runs: input.runs.map((run, index) => ({
      id: `run-${run.side}-${index}`,
      side: run.side,
      worktree: run.worktree,
      worktreeActive: run.worktreeActive ?? true,
    })),
    history: Array.from({ length: input.history ?? 0 }, (_unused, index) => ({ index })),
    ...(input.turn === false
      ? {}
      : { turn: { index: input.turnIndex ?? 0, state: input.state ?? "running" } }),
  } as unknown as ArenaSnapshot;
}

const target = (over: Partial<ArenaTerminalTarget> = {}): ArenaTerminalTarget => ({
  runId: "run-a",
  worktree: "/p/.agent-duel/worktrees/generation-0-a",
  turnIndex: 0,
  ...over,
});

describe("arenaTurnLabel", () => {
  it("counts from one, because the wire counts from zero", () => {
    expect(arenaTurnLabel(0)).toBe("turn 1");
    expect(arenaTurnLabel(4)).toBe("turn 5");
  });
});

describe("resolveArenaTerminalTarget", () => {
  it("resolves the side's live worktree", () => {
    const resolved = resolveArenaTerminalTarget(
      snapshot({
        turnIndex: 3,
        runs: [
          { side: "a", worktree: "/w/a" },
          { side: "b", worktree: "/w/b" },
        ],
      }),
      "b",
    );
    expect(resolved).toEqual({ runId: "run-b-1", worktree: "/w/b", turnIndex: 3 });
  });

  it("refuses a worktree the daemon has already removed", () => {
    const removed = snapshot({ runs: [{ side: "a", worktree: "/w/a", worktreeActive: false }] });
    expect(resolveArenaTerminalTarget(removed, "a")).toBeNull();
  });

  it("returns null for a side that has no run yet, and for no snapshot", () => {
    expect(
      resolveArenaTerminalTarget(snapshot({ runs: [{ side: "a", worktree: "/w/a" }] }), "b"),
    ).toBeNull();
    expect(resolveArenaTerminalTarget(undefined, "a")).toBeNull();
  });

  it("treats a blank worktree as absent", () => {
    expect(
      resolveArenaTerminalTarget(snapshot({ runs: [{ side: "a", worktree: "   " }] }), "a"),
    ).toBeNull();
  });
});

describe("resolveArenaSeatTerminalSides", () => {
  it("offers both seats while the battle has two environments", () => {
    const sides = resolveArenaSeatTerminalSides(
      snapshot({
        runs: [
          { side: "a", worktree: "/p/generation-0-a" },
          { side: "b", worktree: "/p/generation-0-b" },
        ],
      }),
    );

    expect(sides).toEqual(["a", "b"]);
  });

  it("offers neither once the turn is decided, retained winner and all", () => {
    // The winner is retained until the next send. On its own it is just the workspace's
    // environment, so naming a contestant would name one that has no opponent left.
    const sides = resolveArenaSeatTerminalSides(
      snapshot({
        state: "complete",
        runs: [
          { side: "a", worktree: "/p/generation-0-a" },
          { side: "b", worktree: "/p/generation-0-b", worktreeActive: false },
        ],
      }),
    );

    expect(sides).toEqual([]);
  });

  it("offers the seat that is ready while its opponent is still being prepared", () => {
    // A battle that is starting has one worktree before the other. The seat that exists is
    // usable; the one still being made is not, and says so in its own pane.
    const sides = resolveArenaSeatTerminalSides(
      snapshot({
        state: "creating",
        runs: [
          { side: "a", worktree: "/p/generation-1-a" },
          { side: "b", worktree: "", worktreeActive: false },
        ],
      }),
    );

    expect(sides).toEqual(["a"]);
  });

  it("offers neither outside a battle", () => {
    expect(resolveArenaSeatTerminalSides(undefined)).toEqual([]);
    expect(resolveArenaSeatTerminalSides(snapshot({ runs: [] }))).toEqual([]);
  });
});

describe("resolveArenaSeatMenuSides", () => {
  it("offers both seats once the chat has held a battle, decided or not", () => {
    expect(resolveArenaSeatMenuSides(snapshot({ state: "complete", runs: [] }))).toEqual([
      "a",
      "b",
    ]);
    // The turn is over and gone from `turn`, but the chat is still a battle chat: the seats a
    // reader opened before the vote are the seats the next turn will fill.
    expect(resolveArenaSeatMenuSides(snapshot({ turn: false, history: 2, runs: [] }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("offers neither to a chat that has never held one", () => {
    expect(resolveArenaSeatMenuSides(undefined)).toEqual([]);
    expect(resolveArenaSeatMenuSides(snapshot({ turn: false, runs: [] }))).toEqual([]);
  });
});

describe("planArenaTerminalTransition", () => {
  it("attaches the first time a worktree appears", () => {
    const next = target();
    expect(planArenaTerminalTransition({ previous: null, next })).toEqual({
      kind: "attach",
      target: next,
    });
  });

  it("does nothing while the worktree is unchanged", () => {
    // Same directory, a fresh snapshot object: the tab must not churn on every poll.
    expect(
      planArenaTerminalTransition({ previous: target(), next: target({ runId: "other" }) }),
    ).toEqual({ kind: "idle" });
  });

  it("advances with a divider when the turn moves to a new worktree", () => {
    const next = target({ worktree: "/p/.agent-duel/worktrees/generation-1-a", turnIndex: 1 });
    expect(planArenaTerminalTransition({ previous: target(), next })).toEqual({
      kind: "advance",
      target: next,
      dividerLabel: "turn 2",
    });
  });

  it("detaches without clearing when the worktree goes and nothing replaces it", () => {
    expect(planArenaTerminalTransition({ previous: target(), next: null })).toEqual({
      kind: "detach",
    });
  });

  it("stays idle when there was never anything to point at", () => {
    expect(planArenaTerminalTransition({ previous: null, next: null })).toEqual({ kind: "idle" });
  });

  it("still draws the rule when the worktree went away before the next turn arrived", () => {
    // The real sequence: vote -> the worktree is removed -> the next turn starts. The pane
    // holds its last target across the gap, so the successor reads as a turn change rather
    // than as a first attach with nothing to separate from.
    const turnOne = target();
    expect(planArenaTerminalTransition({ previous: turnOne, next: null })).toEqual({
      kind: "detach",
    });

    const turnTwo = target({ worktree: "/p/.agent-duel/worktrees/generation-1-a", turnIndex: 1 });
    expect(planArenaTerminalTransition({ previous: turnOne, next: turnTwo })).toEqual({
      kind: "advance",
      target: turnTwo,
      dividerLabel: "turn 2",
    });
  });
});
