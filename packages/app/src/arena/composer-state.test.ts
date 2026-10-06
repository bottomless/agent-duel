import { describe, expect, it } from "vitest";
import { deriveArenaComposerQueueState, resolveArenaComposerSubmit } from "./composer-state";

const BASE = {
  battleIsActive: true,
  battleMode: false,
  battleReplyEnabled: false,
  canQueueNextTurn: false,
  hasQueuedFollowUp: false,
  hasReplyableTurn: false,
  hasReplyActions: false,
  parkedPromotion: false,
  useLegacyBattleLoading: false,
};

describe("deriveArenaComposerQueueState", () => {
  it("locks the composer during a battle that cannot take a message", () => {
    expect(deriveArenaComposerQueueState(BASE).disabled).toBe(true);
  });

  it("leaves it open while a promotion is parked on the user", () => {
    // The chat is still `battle_active` and the parked turn is not replyable, so every gate
    // written for "a battle is running" would lock the one composer this state depends on.
    expect(deriveArenaComposerQueueState({ ...BASE, parkedPromotion: true }).disabled).toBe(false);
  });

  it("still locks a parked-looking state that is actually a live battle", () => {
    expect(
      deriveArenaComposerQueueState({ ...BASE, hasReplyableTurn: true, hasReplyActions: false })
        .disabled,
    ).toBe(true);
  });

  it("keeps queueing the next turn once a resolution is running", () => {
    expect(deriveArenaComposerQueueState({ ...BASE, canQueueNextTurn: true })).toMatchObject({
      arenaFollowUp: "single_agent",
      defaultSendBehavior: "queue",
      disabled: false,
    });
  });
});

describe("resolveArenaComposerSubmit", () => {
  const submitBattle = async () => {};

  it("sends single-agent turns while battles are paused", () => {
    // Battle mode is switched off for both pause reasons, so neither routes to the battle submit.
    expect(
      resolveArenaComposerSubmit({
        battleReplyEnabled: false,
        battleMode: false,
        trunkConflicted: false,
        submitBattle,
      }),
    ).toBeUndefined();
    expect(
      resolveArenaComposerSubmit({
        battleReplyEnabled: false,
        battleMode: true,
        trunkConflicted: true,
        submitBattle,
      }),
    ).toBeUndefined();
  });

  it("routes to the battle submit only when battle mode is genuinely on", () => {
    expect(
      resolveArenaComposerSubmit({
        battleReplyEnabled: false,
        battleMode: true,
        trunkConflicted: false,
        submitBattle,
      }),
    ).toBe(submitBattle);
  });
});
