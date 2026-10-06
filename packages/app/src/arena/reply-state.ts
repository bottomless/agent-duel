import type { ArenaReplyTarget, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { activeTrunkConflicts } from "./conflict-guard";

export const ARENA_CONFLICT_RESOLUTION_PROMPT = "Please resolve the conflicts.";

export interface ArenaReplyAction {
  target: ArenaReplyTarget;
  label: string;
  isDefault?: boolean;
}

export interface ArenaReplySelection {
  turnId: string;
  target: ArenaReplyTarget | null;
}

/**
 * Keeps an explicit reply target stable as run states change within one battle.
 *
 * A new turn starts on its preferred action, Both whenever both sides can take a message. Both stays
 * available while one side finishes before the other, so it is not cleared in the ordinary course of
 * a battle. A target that does disappear, because its side failed or stopped, is cleared instead of
 * silently moving the draft to another contestant, and stays cleared until the user chooses again.
 */
export function reconcileArenaReplySelection(
  previous: ArenaReplySelection | null,
  turnId: string | null,
  actions: readonly ArenaReplyAction[],
): ArenaReplySelection | null {
  // Reply controls disappear briefly while a turn changes phase. Keep the previous choice
  // through that gap so an invalidated target cannot silently reset to a new default.
  if (!turnId || actions.length === 0) return previous;
  if (previous?.turnId !== turnId) {
    return {
      turnId,
      target: actions.find((action) => action.isDefault)?.target ?? actions[0]?.target ?? null,
    };
  }
  if (previous.target === null) return previous;
  return actions.some((action) => action.target === previous.target)
    ? previous
    : { turnId, target: null };
}

export function canDrainArenaFollowUp(snapshot: ArenaSnapshot | undefined): boolean {
  if (snapshot?.chat.status !== "ready" || snapshot.chat.activeTurnID !== undefined) return false;
  // Conflicts keep a chat `ready`, so without this the queued battle drains straight into the
  // daemon's refusal and the prompt is spent on a toast. It waits for a clean trunk instead.
  return activeTrunkConflicts(snapshot.chat) === null;
}

export function arenaConflictResolutionTurnID(snapshot: ArenaSnapshot | undefined): string | null {
  if (!canDrainArenaFollowUp(snapshot)) return null;
  const latestTurn = snapshot?.history.at(-1);
  if (latestTurn?.state !== "complete" || latestTurn.gitApplication?.state !== "conflicted") {
    return null;
  }
  return latestTurn.id;
}

export function arenaSteeringQueuedMessage(action: ArenaReplyAction): string | null {
  if (!action.label.startsWith("Steer ")) return null;
  if (action.target === "both") return "Steering queued for both contestants.";
  return `Steering queued for contestant ${action.target.toUpperCase()}.`;
}

function sideAction(side: "a" | "b", runState: "pending" | "complete"): ArenaReplyAction {
  return {
    target: side,
    label: `${runState === "pending" ? "Steer" : "Message"} ${side.toUpperCase()}`,
  };
}

function deriveReplyActions(runs: ArenaSnapshot["runs"]): readonly ArenaReplyAction[] {
  const a = runs.find((run) => run.side === "a");
  const b = runs.find((run) => run.side === "b");
  const replyableRunState = (runState: ArenaSnapshot["runs"][number]["runState"]) =>
    runState === "pending" || runState === "complete";
  const replyActions: ArenaReplyAction[] = [];
  if (a && replyableRunState(a.runState)) replyActions.push(sideAction("a", a.runState));
  if (b && replyableRunState(b.runState)) replyActions.push(sideAction("b", b.runState));
  // Both whenever each side can take a message, even when one is still working and the other has
  // finished: the engine steers the one and resumes the other with the same message.
  if (a && b && replyableRunState(a.runState) && replyableRunState(b.runState)) {
    replyActions.push({
      target: "both",
      label: `${a.runState === "pending" && b.runState === "pending" ? "Steer" : "Message"} both`,
      isDefault: true,
    });
    return replyActions;
  }
  const steeringAction = replyActions.find((action) => action.label.startsWith("Steer "));
  if (steeringAction) steeringAction.isDefault = true;
  return replyActions;
}

export function deriveArenaReplyState(snapshot: ArenaSnapshot | undefined): {
  battleIsActive: boolean;
  canQueueNextTurn: boolean;
  replyableBattleTurn: ArenaSnapshot["turn"] | null;
  replyActions: readonly ArenaReplyAction[];
} {
  const battleIsActive = snapshot?.chat.status === "battle_active";
  const turn = snapshot?.turn;
  const canQueueNextTurn =
    battleIsActive &&
    turn?.resolution !== undefined &&
    (turn.state === "early_selected" ||
      turn.state === "applying" ||
      turn.state === "canonicalizing" ||
      turn.state === "cleanup_pending");
  const replyableBattleTurn =
    battleIsActive && (turn?.state === "running" || turn?.state === "awaiting_vote") ? turn : null;

  if (!replyableBattleTurn) {
    return {
      battleIsActive,
      canQueueNextTurn,
      replyableBattleTurn: null,
      replyActions: [],
    };
  }

  return {
    battleIsActive,
    canQueueNextTurn,
    replyableBattleTurn,
    replyActions: deriveReplyActions(snapshot?.runs ?? []),
  };
}
