import { ARENA_MAX_IMAGES } from "@/arena/constants";
import type { MessagePayload } from "@/composer/types";

/**
 * What the composer does while a battle owns the chat.
 *
 * These were inline in the agent panel, where nothing could test them, and the parked-promotion
 * states kept tripping over them one at a time: the chat is `battle_active`, its turn is not
 * replyable, and every gate written for "a battle is running" locked the composer that a parked
 * promotion actually needs.
 */
export function resolveArenaComposerSubmit(input: {
  battleReplyEnabled: boolean;
  battleMode: boolean;
  trunkConflicted: boolean;
  submitBattle: (payload: MessagePayload) => Promise<void>;
}): ((payload: MessagePayload) => Promise<void>) | undefined {
  if (input.battleReplyEnabled) return undefined;
  // Battles are paused on a conflicted trunk but the chat is not: resolving is a conversation, and
  // the agent may ask which side of a hunk to keep. Routing to the battle submit would put every
  // answer into a start the daemon refuses, so sends fall through to the single-agent path while
  // the switch keeps the user's preference for the battle waiting in the queue.
  if (input.trunkConflicted) return undefined;
  if (input.battleMode) return input.submitBattle;
  return undefined;
}

export function deriveArenaComposerQueueState(input: {
  battleIsActive: boolean;
  battleMode: boolean;
  battleReplyEnabled: boolean;
  canQueueNextTurn: boolean;
  hasQueuedFollowUp: boolean;
  hasReplyableTurn: boolean;
  hasReplyActions: boolean;
  /**
   * A promotion parked on the user. The chat is `battle_active` and its turn is not replyable, so
   * without this the composer locks — and a parked promotion is precisely when the composer is
   * needed, to ask an agent for help or to answer the one it asks back.
   */
  parkedPromotion: boolean;
  useLegacyBattleLoading: boolean;
}): {
  arenaFollowUp?: "battle" | "single_agent";
  defaultSendBehavior?: "interrupt" | "queue";
  disabled: boolean;
} {
  if (input.canQueueNextTurn) {
    return {
      arenaFollowUp: input.battleMode ? "battle" : "single_agent",
      defaultSendBehavior: "queue",
      disabled: input.hasQueuedFollowUp,
    };
  }
  return {
    defaultSendBehavior: input.battleReplyEnabled ? "interrupt" : undefined,
    disabled:
      input.battleIsActive &&
      !input.parkedPromotion &&
      (!input.hasReplyableTurn || !input.hasReplyActions) &&
      !input.useLegacyBattleLoading,
  };
}

/** The image limit for a composer whose sends go to the battle engine; a single agent's has none. */
export function arenaComposerMaxImages(sendsToBattle: boolean): number | undefined {
  return sendsToBattle ? ARENA_MAX_IMAGES : undefined;
}
