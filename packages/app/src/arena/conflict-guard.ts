import type { ArenaReviewItem, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { isArenaBattleOnScreen } from "./summary-anchor";

/**
 * The trunk merge-conflict guard. The daemon refuses a battle while the trunk holds unmerged
 * files, so the app pauses battles and offers the single-agent way out from the callout.
 *
 * The guard never writes to the composer. It used to prefill the resolve prompt into an empty
 * draft, which read as the app eating what you typed: the battle create path drops the prompt on
 * a conflicted trunk, and the prefill landed in the hole that left. Your draft is yours; the
 * resolve prompt is a button.
 */

export const CONFLICT_PROMPT = "help me resolve conflicts";

/**
 * What the resolve button actually sends.
 *
 * One prompt for both pauses, because both end the same way: the markers gone. A conflicted trunk
 * is the user's own merge, whose natural end is their commit. A parked promotion is the winner
 * already written into the workspace with markers where it collided, and the resume reads those
 * markers — not the index, which the promotion leaves merged, and not a cherry-pick sequencer,
 * which it never opens. Naming `git add` on top of that would name a step that settles nothing.
 */
export function conflictResolvePrompt(_parked?: ArenaParkedPromotion | null): string {
  return CONFLICT_PROMPT;
}

type GuardChat = Pick<ArenaSnapshot["chat"], "status" | "blockedReason" | "trunkConflicts">;

export interface ConflictGuardInput {
  trunkConflicts: readonly string[] | null | undefined;
  /** The chat carries a `blockedReason`. It refuses battles for its own reason, not a conflict. */
  blocked: boolean;
  battleMode: boolean;
  /**
   * A promotion parked on the user. It pauses battles for the same reason a conflicted trunk
   * does — the daemon refuses a battle while the turn is unresolved — and it clears the same way,
   * so it takes the same pause rather than a second mechanism that looks almost like it.
   */
  parkedPromotion?: boolean;
}

export interface ConflictGuardDecision {
  /** Battles are paused and will resume on their own. A blocked chat is not active. */
  active: boolean;
  forceBattleOff: boolean;
  /** Stable key for the current conflict list, null when there are none. */
  conflictKey: string | null;
}

/**
 * The conflict list the guard acts on. A blocked chat keeps whatever the last ready inspection saw
 * and the engine never refreshes it, so `blockedReason` wins and the frozen list is ignored.
 */
export function activeTrunkConflicts(chat: GuardChat): readonly string[] | null {
  if (chat.blockedReason) return null;
  return chat.trunkConflicts?.length ? chat.trunkConflicts : null;
}

/** The Battle toggle is dead while a battle runs, while the chat is blocked, and while conflicts stand. */
export function resolveBattleModeDisabled(chat: GuardChat | undefined): boolean {
  if (!chat) return false;
  if (chat.status === "battle_active" || chat.blockedReason) return true;
  return activeTrunkConflicts(chat) !== null;
}

/** One appearance of one conflict set. A cleared trunk yields null, so the next set prefills again. */
function trunkConflictKey(trunkConflicts: readonly string[] | null | undefined): string | null {
  if (!trunkConflicts || trunkConflicts.length === 0) return null;
  return trunkConflicts.join("\n");
}

/**
 * A fresh chat, resolved but not yet started. The daemon refuses a battle on a conflicted or
 * blocked trunk, so the draft composer hands the created agent off instead of spending the send.
 */
export function canStartBattleOnChat(chat: GuardChat): boolean {
  return !chat.blockedReason && activeTrunkConflicts(chat) === null;
}

/**
 * The callout's sentence.
 *
 * `ArenaPathList`'s heading counts the files and its rows name them, so the sentence does neither.
 * It used to open with the count, which put "2 files have unresolved merge conflicts" directly
 * above "Conflicting files (2)".
 *
 * "Let one agent resolve them" used to live here too, which is what the button says. Two lines
 * of prose competing with the action is what made the callout feel crowded.
 */
export const CONFLICT_CALLOUT_DETAIL =
  "The files below have unresolved merge conflicts. Battles resume once the trunk is clean.";

export function resolveConflictGuard(input: ConflictGuardInput): ConflictGuardDecision {
  const conflictKey = trunkConflictKey(input.trunkConflicts);
  const active = conflictKey !== null || input.parkedPromotion === true;
  return {
    active,
    // Conflicts clear; a blocked chat does not. Turning Battle off for a conflict threw away a
    // preference the user has to set again minutes later, so the switch keeps its position and
    // `resolveBattleModeDisabled` holds it still until the trunk is clean.
    forceBattleOff: input.blocked && input.battleMode,
    conflictKey,
  };
}

/**
 * Moving the Battle switch for a conflict, and moving it back afterwards.
 *
 * A battle cannot run on a half-merged tree, so leaving the switch on through a conflict shows a
 * control that lies about what the next send does. Turning it off loses the user's choice, which
 * is why the previous position is remembered rather than assumed: a conflict is a pause, and the
 * switch has to come back exactly where they left it, not at the default.
 */
export function resolveBattlePause(input: {
  conflictsActive: boolean;
  battleMode: boolean;
  battleModeBeforeConflict: boolean | undefined;
}): { battleMode: boolean; battleModeBeforeConflict: boolean | undefined } | null {
  const paused = input.battleModeBeforeConflict !== undefined;
  if (input.conflictsActive) {
    if (paused)
      return input.battleMode
        ? { battleMode: false, battleModeBeforeConflict: input.battleModeBeforeConflict }
        : null;
    return { battleMode: false, battleModeBeforeConflict: input.battleMode };
  }
  if (!paused) return null;
  return {
    battleMode: input.battleModeBeforeConflict === true,
    battleModeBeforeConflict: undefined,
  };
}

/**
 * A promotion parked on the user.
 *
 * Three shapes, one situation: `conflicted` left markers in the checkout; `review` has not touched
 * it and waits for answers; `stopped` (Git `manual` or `blocked`) could not start writing and waits
 * for a retry or a discard. Each is the trunk-conflict guard's predicament arriving through another
 * door — the chat is `battle_active` rather than `ready`, so `trunkConflicts` is never set and the
 * state has to be derived from the parked turn instead. The daemon's `isParkedPromotion` names the
 * same states; the two must agree, or the composer unlocks for a prompt the daemon refuses.
 *
 * Each renders as a callout above a live composer, in the one place Arena puts callouts. The
 * decision bar cannot host them: it stands in the composer's slot, and a parked promotion is
 * exactly when you need the composer — to ask an agent for help, or to answer the one it asks
 * back.
 */
export type ArenaParkedPromotion =
  | { kind: "conflicted"; conflicts: readonly string[] }
  | {
      kind: "review";
      items: readonly ArenaReviewItem[];
      planned: readonly { ref: string; action: string }[];
      /** The branch the workspace switches to once the review is answered. */
      switchTo?: string;
      canDiscard: boolean;
    }
  | {
      kind: "stopped";
      reason?: string;
      canRetry: boolean;
      canDiscard: boolean;
      /** The apply wrote part of the winner and could not undo it; the workspace must be restored first. */
      partial: boolean;
    };

export function arenaParkedPromotion(
  snapshot: ArenaSnapshot | undefined,
): ArenaParkedPromotion | null {
  const turn = snapshot?.turn;
  if (turn?.state !== "application_failed") return null;
  const application = turn.gitApplication;
  const canDiscard = turn.canDiscardWinner === true;
  if (application?.state === "conflicted" && turn.canRetryResolution) {
    return { kind: "conflicted", conflicts: application.conflicts ?? [] };
  }
  if (application?.state === "review" && application.review) {
    return {
      kind: "review",
      items: application.review.items,
      planned: application.review.planned,
      ...(application.review.switchTo ? { switchTo: application.review.switchTo } : {}),
      canDiscard,
    };
  }
  if (application?.state === "manual" || application?.state === "blocked") {
    return {
      kind: "stopped",
      ...(application.reason ? { reason: application.reason } : {}),
      canRetry: turn.canRetryResolution,
      canDiscard,
      partial: application.partial !== undefined,
    };
  }
  return null;
}

/**
 * The conflicted callout's sentence, for the files the list below it names.
 *
 * There is no button to finish with — the winner applies itself once the markers are gone — so the
 * sentence has to name what ends this. Clearing the markers is the whole of it: the promotion
 * wrote its result in one step, leaving ordinary dirty files rather than an unmerged index, so
 * there is nothing to stage and no Git operation left to continue.
 */
export function conflictRepairDetail(_input: { conflicts: readonly string[] }): string {
  return "The changes were merged into this workspace, with conflicts in the files below. Resolve them yourself or ask an agent — clearing the conflict markers is all that is left. You can keep chatting.";
}

/**
 * A battle holds the composer while it is on screen and while its promotion is parked, so the
 * composer's controls speak for both contestants.
 */
export function battleHoldsComposer(snapshot: ArenaSnapshot | undefined): boolean {
  return isArenaBattleOnScreen(snapshot) || arenaParkedPromotion(snapshot) !== null;
}

/**
 * The Battle switch is hidden while a battle holds the composer and while a single-agent turn
 * runs. A parked chat sends single-agent turns until it clears, and the switch returns where it
 * was for the next follow-up (`resolveBattlePause`). A running single agent takes the next send as
 * a steer; with Battle switched on mid-run, that send went to a battle start instead and the agent
 * could not be steered.
 */
export function hidesBattleToggle(input: {
  snapshot: ArenaSnapshot | undefined;
  agentRunning: boolean;
}): boolean {
  return input.agentRunning || battleHoldsComposer(input.snapshot);
}
