import type { ArenaRun, ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaSetupStatus } from "./transition-progress";
import { resolutionRetryDetail } from "./battle-result";
import { arenaParkedPromotion } from "./conflict-guard";
import { isArenaBattleUnresolved } from "./summary-anchor";
import { canChooseArenaRun, canKeepStoppedArenaRun, canStopArenaBattle } from "./vote-state";

export interface ArenaDecisionSide {
  side: ArenaSide;
  run: ArenaRun | undefined;
}

/**
 * What the decision bar offers for the turn's current state.
 *
 * Every decision a battle asks of the voter lives here, so a state that
 * reaches the bar always maps to one of these. Status labels and elapsed
 * time are rendered from the `run` refs by the bar itself; the phase does
 * not depend on the clock and so does not change between polls.
 */
export type ArenaDecisionPhase =
  | {
      kind: "running";
      a: ArenaDecisionSide;
      b: ArenaDecisionSide;
      /** The side still working while the other has settled. */
      waitingFor: ArenaSide | null;
      canStop: boolean;
      canPickA: boolean;
      canPickB: boolean;
    }
  | { kind: "awaiting_vote"; canChooseA: boolean; canChooseB: boolean }
  | { kind: "awaiting_stop_resolution"; canKeepA: boolean; canKeepB: boolean }
  | { kind: "retry_resolution"; detail: string }
  | { kind: "transitional"; label: string; busy: boolean };

/**
 * An unresolved battle has decision UI. The host may put running actions in a
 * reply composer; failed application and canonicalization still use the bar
 * for as long as their resolution can be retried.
 */
export function showsArenaDecisionBar(snapshot: ArenaSnapshot | undefined): boolean {
  // A parked promotion hands the slot back instead: its callout sits above a live composer,
  // because that is where you ask an agent for help or answer the one it asks back.
  if (arenaParkedPromotion(snapshot)) return false;
  return isArenaBattleUnresolved(snapshot) || snapshot?.turn?.canRetryResolution === true;
}

/** Running and completed battle choices live in the floating pill. */
export function decisionBarShowsPhase(phase: ArenaDecisionPhase): boolean {
  return phase.kind === "retry_resolution" || phase.kind === "transitional";
}

export function arenaRunningDecisionOrder({
  canPickA,
  canPickB,
}: Pick<Extract<ArenaDecisionPhase, { kind: "running" }>, "canPickA" | "canPickB">): (
  | ArenaSide
  | "stop"
)[] {
  if (canPickA) return canPickB ? ["a", "stop", "b"] : ["a", "stop"];
  return canPickB ? ["stop", "b"] : ["stop"];
}

/**
 * Setup reports its steps in the conversation and the bar stays hidden until it is done
 * (`decision-bar.tsx`), so this phase never reaches the screen and needs no step names.
 */
const PREPARING_WORKSPACES = "Preparing workspaces";

function transitional(label: string, busy: boolean): ArenaDecisionPhase {
  return { kind: "transitional", label, busy };
}

function settled(run: ArenaRun | undefined): boolean {
  return run !== undefined && run.runState !== "pending";
}

function waitingFor(runA: ArenaRun | undefined, runB: ArenaRun | undefined): ArenaSide | null {
  if (settled(runA) && !settled(runB)) return "b";
  if (settled(runB) && !settled(runA)) return "a";
  return null;
}

export function arenaDecisionPhase(snapshot: ArenaSnapshot): ArenaDecisionPhase {
  const turn = snapshot.turn;
  const runA = snapshot.runs.find((run) => run.side === "a");
  const runB = snapshot.runs.find((run) => run.side === "b");
  // Neither parked state reaches the bar — `showsArenaDecisionBar` sends both to the callout — so
  // this is the rest: a failed canonicalization, or a promotion that never reached the checkout.
  if (turn?.canRetryResolution) {
    return { kind: "retry_resolution", detail: resolutionRetryDetail(turn.gitApplication) };
  }
  if (!turn) return transitional(PREPARING_WORKSPACES, true);
  switch (turn.state) {
    case "creating":
    case "worktrees_ready":
      return transitional(PREPARING_WORKSPACES, true);
    case "running": {
      // The panes stay hidden while files are still copying, so a result cannot be judged yet.
      // Stop stays: the engine aborts the copy instead of waiting for it.
      const settingUp = arenaSetupStatus(turn) !== null;
      return {
        kind: "running",
        a: { side: "a", run: runA },
        b: { side: "b", run: runB },
        waitingFor: waitingFor(runA, runB),
        canStop: canStopArenaBattle(turn.state),
        canPickA: !settingUp && canChooseArenaRun(turn.state, runA),
        canPickB: !settingUp && canChooseArenaRun(turn.state, runB),
      };
    }
    case "finalizing":
      return transitional("Finishing up", true);
    case "awaiting_vote":
      return {
        kind: "awaiting_vote",
        canChooseA: canChooseArenaRun(turn.state, runA),
        canChooseB: canChooseArenaRun(turn.state, runB),
      };
    case "stopping":
      return transitional("Stopping the battle", true);
    case "awaiting_stop_resolution":
      return {
        kind: "awaiting_stop_resolution",
        canKeepA: canKeepStoppedArenaRun(turn.state, runA),
        canKeepB: canKeepStoppedArenaRun(turn.state, runB),
      };
    case "creation_failed":
      return transitional("Battle failed to start", false);
    case "finalization_failed":
      return transitional("Battle failed to finish", false);
    case "interrupted_recovery":
      return transitional("Recovering the interrupted battle", true);
    default:
      // This only covers a snapshot caught between two polls.
      return transitional("Resolving the battle", true);
  }
}
