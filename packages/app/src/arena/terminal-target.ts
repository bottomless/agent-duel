import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

/** The contestant environment one side's terminal tab is pointed at right now. */
export interface ArenaTerminalTarget {
  runId: string;
  worktree: string;
  /** 0-based on the wire; only `arenaTurnLabel` turns it into something a person reads. */
  turnIndex: number;
}

/**
 * What the tab should do next, given where it was pointed and where it should be.
 *
 * `advance` is the whole point of the tab: the previous turn's shell is gone with its
 * worktree, but the buffer it wrote is still the thing the developer was reading, so the
 * pane keeps it and marks the seam instead of starting a new pane.
 */
export type ArenaTerminalTransition =
  | { kind: "idle" }
  | { kind: "attach"; target: ArenaTerminalTarget }
  | { kind: "advance"; target: ArenaTerminalTarget; dividerLabel: string }
  | { kind: "detach" };

const ARENA_SIDES: readonly ArenaSide[] = ["a", "b"];
const EMPTY_SIDES: readonly ArenaSide[] = [];

/** Turn indices are 0-based on the wire; a battle a person is looking at is the first one. */
export function arenaTurnLabel(turnIndex: number): string {
  return `turn ${Math.max(0, Math.trunc(turnIndex)) + 1}`;
}

/**
 * Resolve from the run's own `worktreeActive` rather than the turn state: it is the
 * daemon's record of whether the directory is still on disk, and it stays true for the
 * winner that is retained past the vote until the next send.
 */
export function resolveArenaTerminalTarget(
  snapshot: ArenaSnapshot | undefined,
  side: ArenaSide,
): ArenaTerminalTarget | null {
  const run = snapshot?.runs.find((candidate) => candidate.side === side);
  if (!run || run.worktreeActive === false) {
    return null;
  }
  const worktree = run.worktree.trim();
  if (!worktree) {
    return null;
  }
  return { runId: run.id, worktree, turnIndex: snapshot?.turn?.index ?? 0 };
}

/**
 * States in which the battle is still something the reader is looking at: being set up, running,
 * or settled but not yet resolved. Everything after that — applying the winner, canonicalizing,
 * cleaning up, discarded — has decided the turn, and the winner's retained worktree is the
 * workspace's environment from then on rather than a contestant's.
 */
const LIVE_BATTLE_STATES: ReadonlySet<string> = new Set([
  "creating",
  "worktrees_ready",
  "running",
  "early_selected",
  "finalizing",
  "awaiting_vote",
  "stopping",
  "awaiting_stop_resolution",
]);

export function isArenaBattleLive(snapshot: ArenaSnapshot | undefined): boolean {
  const state = snapshot?.turn?.state;
  return typeof state === "string" && LIVE_BATTLE_STATES.has(state);
}

/**
 * The seats a shell can be opened in, and equally the seats whose shells still have somewhere
 * to work: a side of a live battle that has its worktree. A decided turn has no seats at all,
 * which is what makes both contestant terminals pause together rather than one of them living
 * on in the environment that happened to win.
 */
export function resolveArenaSeatTerminalSides(
  snapshot: ArenaSnapshot | undefined,
): readonly ArenaSide[] {
  if (!isArenaBattleLive(snapshot)) {
    return EMPTY_SIDES;
  }
  return ARENA_SIDES.filter((side) => resolveArenaTerminalTarget(snapshot, side) !== null);
}

/**
 * Whether this chat has ever started a battle.
 *
 * A turn document only exists for a battle, so one in flight or one in the history is enough. A
 * chat that has only ever sent to a single agent has neither.
 */
export function hasArenaBattleHistory(snapshot: ArenaSnapshot | undefined): boolean {
  return snapshot !== undefined && (snapshot.turn !== undefined || snapshot.history.length > 0);
}

/**
 * The seats the "+" menu offers, which is not the same question as where a shell can work.
 *
 * Once a chat has held a battle, both seats stay on the menu for the rest of it. Between turns a
 * seat has no worktree, and the shell opened there waits for the next one rather than being
 * refused — the reader asking for Agent A's terminal between turns is asking for the terminal
 * the next turn will fill, and a menu that empties itself every time a battle is decided is a
 * menu nobody can find twice.
 */
export function resolveArenaSeatMenuSides(
  snapshot: ArenaSnapshot | undefined,
): readonly ArenaSide[] {
  return hasArenaBattleHistory(snapshot) ? ARENA_SIDES : EMPTY_SIDES;
}

export function planArenaTerminalTransition(input: {
  previous: ArenaTerminalTarget | null;
  next: ArenaTerminalTarget | null;
}): ArenaTerminalTransition {
  const { previous, next } = input;
  if (!next) {
    // The worktree went away and no successor exists yet. The buffer stays on screen;
    // pulling the pane out from under whoever is reading it would be the worse answer.
    return previous ? { kind: "detach" } : { kind: "idle" };
  }
  if (!previous) {
    return { kind: "attach", target: next };
  }
  if (previous.worktree === next.worktree) {
    return { kind: "idle" };
  }
  return { kind: "advance", target: next, dividerLabel: arenaTurnLabel(next.turnIndex) };
}
