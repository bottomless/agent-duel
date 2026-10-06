import type { ArenaRun, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

export type ArenaTurnState = NonNullable<ArenaSnapshot["turn"]>["state"];

export function canChooseArenaRun(state: ArenaTurnState, run: ArenaRun | undefined): boolean {
  const voteIsOpen = state === "running" || state === "awaiting_vote";
  return voteIsOpen && run?.selectable === true;
}

// The engine only accepts a stop while both sides are still running
// (arena/service.ts `Arena.stop`); asking later fails.
export function canStopArenaBattle(state: ArenaTurnState): boolean {
  return state === "running";
}

export function canKeepStoppedArenaRun(state: ArenaTurnState, run: ArenaRun | undefined): boolean {
  return state === "awaiting_stop_resolution" && run?.applicable === true;
}
