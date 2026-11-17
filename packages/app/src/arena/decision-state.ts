import { i18n } from "@/i18n/i18next";
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
  | {
      kind: "awaiting_vote";
      canChooseA: boolean;
      canChooseB: boolean;
      /** Only between two results that can be chosen; a tie applies A whatever A is. */
      canTie: boolean;
      /**
       * Only once a side failed or the restart cut the battle off. Two results that can be chosen
       * are voted on, so the pill offers no way around the vote.
       */
      canDiscard: boolean;
      /** Neither result can be chosen, so Tie leaves the pill. */
      bothFailed: boolean;
      /** A failed side whose work can be taken anyway, in place of its Choose. */
      canAcceptA: boolean;
      canAcceptB: boolean;
      /** A failed side can still be retried, which the failure line above the pill offers. */
      canRetry: boolean;
      /**
       * The one side that failed while the other can be chosen. Choosing the other still applies
       * it, but the engine records the vote as not counted, so the hint says so first.
       */
      failedSide: ArenaSide | null;
      /**
       * The engine's restart cut off a side. Resume continues every such side together, and until
       * then Discard is the only other choice.
       */
      canResume: boolean;
    }
  | {
      kind: "awaiting_stop_resolution";
      canKeepA: boolean;
      canKeepB: boolean;
      /** Sides that failed before the stop. Keeping either side then does not count as a vote. */
      failedA: boolean;
      failedB: boolean;
    }
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

/**
 * The side still working once the other can be picked early, which the row names in that side's
 * place so the pick is not a guess. Null while both run, before a pick is offered, or after.
 */
export function arenaRunningWaitingSide(phase: ArenaDecisionPhase): ArenaSide | null {
  if (phase.kind !== "running" || phase.waitingFor === null) return null;
  if (!phase.canPickA && !phase.canPickB) return null;
  return phase.waitingFor;
}

/**
 * Setup reports its steps in the conversation and the bar stays hidden until it is done
 * (`decision-bar.tsx`), so this phase never reaches the screen and needs no step names.
 */

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

// A battle the engine's restart cut off is resumed or discarded, never voted on.
function awaitingVotePhase(
  turn: NonNullable<ArenaSnapshot["turn"]>,
  runA: ArenaRun | undefined,
  runB: ArenaRun | undefined,
): Extract<ArenaDecisionPhase, { kind: "awaiting_vote" }> {
  const canChooseA = !turn.canResumeBattle && canChooseArenaRun(turn.state, runA);
  const canChooseB = !turn.canResumeBattle && canChooseArenaRun(turn.state, runB);
  const bothFailed = !turn.canResumeBattle && !canChooseA && !canChooseB;
  const failed = failedSide(canChooseA, canChooseB);
  return {
    kind: "awaiting_vote",
    canChooseA,
    canChooseB,
    canTie: turn.canTie,
    canDiscard: turn.canDiscardBattle && (turn.canResumeBattle || bothFailed || failed !== null),
    bothFailed,
    canAcceptA: runA?.canAcceptFailed === true,
    canAcceptB: runB?.canAcceptFailed === true,
    canRetry: runA?.canRetry === true || runB?.canRetry === true,
    canResume: turn.canResumeBattle,
    failedSide: failed,
  };
}

function failedSide(canChooseA: boolean, canChooseB: boolean): ArenaSide | null {
  if (canChooseA === canChooseB) return null;
  return canChooseA ? "b" : "a";
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
  if (!turn) return transitional(i18n.t("arena.prepareWorkspaces"), true);
  if (turn.resolution) return transitional(i18n.t("arena.resolving"), true);
  switch (turn.state) {
    case "creating":
    case "worktrees_ready":
      return transitional(i18n.t("arena.prepareWorkspaces"), true);
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
      return transitional(i18n.t("arena.finishing"), true);
    case "awaiting_vote":
      return awaitingVotePhase(turn, runA, runB);
    case "stopping":
      return transitional(i18n.t("arena.stoppingBattle"), true);
    case "awaiting_stop_resolution":
      return {
        kind: "awaiting_stop_resolution",
        canKeepA: canKeepStoppedArenaRun(turn.state, runA),
        canKeepB: canKeepStoppedArenaRun(turn.state, runB),
        failedA: runA?.runState === "error",
        failedB: runB?.runState === "error",
      };
    case "creation_failed":
      return transitional(i18n.t("arena.failedStart"), false);
    case "finalization_failed":
      return transitional(i18n.t("arena.failedFinish"), false);
    case "interrupted_recovery":
      return transitional(i18n.t("arena.recovering"), true);
    default:
      // This only covers a snapshot caught between two polls.
      return transitional(i18n.t("arena.resolving"), true);
  }
}
