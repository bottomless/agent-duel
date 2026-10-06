import { describe, expect, it } from "vitest";
import {
  activeTrunkConflicts,
  arenaParkedPromotion,
  battleHoldsComposer,
  conflictResolvePrompt,
  conflictRepairDetail,
  canStartBattleOnChat,
  CONFLICT_PROMPT,
  resolveBattlePause,
  CONFLICT_CALLOUT_DETAIL,
  hidesBattleToggle,
  resolveBattleModeDisabled,
  resolveConflictGuard,
} from "./conflict-guard";

describe("CONFLICT_PROMPT", () => {
  it("is the prompt the callout tells the user to send", () => {
    expect(CONFLICT_PROMPT).toBe("help me resolve conflicts");
  });
});

describe("activeTrunkConflicts", () => {
  it("reports the list on a ready chat", () => {
    expect(activeTrunkConflicts({ status: "ready", trunkConflicts: ["src/a.ts"] })).toEqual([
      "src/a.ts",
    ]);
  });

  it("ignores the frozen list a blocked chat carries", () => {
    expect(
      activeTrunkConflicts({
        status: "blocked",
        blockedReason: "The trunk worktree is unavailable.",
        trunkConflicts: ["src/a.ts"],
      }),
    ).toBeNull();
  });

  it("reports null for a clean trunk", () => {
    expect(activeTrunkConflicts({ status: "ready" })).toBeNull();
    expect(activeTrunkConflicts({ status: "ready", trunkConflicts: [] })).toBeNull();
  });
});

describe("resolveBattleModeDisabled", () => {
  it("leaves the toggle live on a ready chat with a clean trunk", () => {
    expect(resolveBattleModeDisabled({ status: "ready" })).toBe(false);
    expect(resolveBattleModeDisabled(undefined)).toBe(false);
  });

  it("kills the toggle while conflicts stand", () => {
    expect(resolveBattleModeDisabled({ status: "ready", trunkConflicts: ["src/a.ts"] })).toBe(true);
  });

  it("kills the toggle during a battle", () => {
    expect(resolveBattleModeDisabled({ status: "battle_active" })).toBe(true);
  });

  it("kills the toggle on a blocked chat", () => {
    expect(
      resolveBattleModeDisabled({ status: "blocked", blockedReason: "The trunk is unavailable." }),
    ).toBe(true);
  });
});

describe("resolveConflictGuard", () => {
  it("stays inactive when the trunk has no conflicts", () => {
    expect(
      resolveConflictGuard({ trunkConflicts: undefined, blocked: false, battleMode: true }),
    ).toEqual({ active: false, forceBattleOff: false, conflictKey: null });
  });

  it("stays inactive when the conflict list is empty", () => {
    expect(resolveConflictGuard({ trunkConflicts: [], blocked: false, battleMode: true })).toEqual({
      active: false,
      forceBattleOff: false,
      conflictKey: null,
    });
  });

  it("raises the callout without touching Battle on a conflict", () => {
    const decision = resolveConflictGuard({
      trunkConflicts: ["src/a.ts", "src/b.ts"],
      blocked: false,
      battleMode: true,
    });

    expect(decision.active).toBe(true);
    // Conflicts clear. Flipping the switch off threw away a preference the user sets again
    // minutes later; resolveBattleModeDisabled holds it still instead.
    expect(decision.forceBattleOff).toBe(false);
    expect(decision.conflictKey).not.toBeNull();
  });

  it("still forces Battle off on a blocked chat, which does not clear on its own", () => {
    const decision = resolveConflictGuard({
      trunkConflicts: null,
      blocked: true,
      battleMode: true,
    });

    expect(decision.forceBattleOff).toBe(true);
    expect(decision.active).toBe(false);
    expect(decision.conflictKey).toBeNull();
  });

  it("leaves a blocked chat alone when Battle is already off", () => {
    expect(
      resolveConflictGuard({ trunkConflicts: null, blocked: true, battleMode: false })
        .forceBattleOff,
    ).toBe(false);
  });

  it("keys one appearance of the same conflicts stably", () => {
    const first = resolveConflictGuard({
      trunkConflicts: ["src/a.ts", "src/b.ts"],
      blocked: false,
      battleMode: false,
    });
    const second = resolveConflictGuard({
      trunkConflicts: ["src/a.ts", "src/b.ts"],
      blocked: false,
      battleMode: false,
    });

    expect(second.conflictKey).toBe(first.conflictKey);
  });

  it("keys a different conflict set differently", () => {
    const first = resolveConflictGuard({
      trunkConflicts: ["src/a.ts"],
      blocked: false,
      battleMode: false,
    });
    const next = resolveConflictGuard({
      trunkConflicts: ["src/b.ts"],
      blocked: false,
      battleMode: false,
    });

    expect(next.conflictKey).not.toBe(first.conflictKey);
  });

  it("never reports a prompt to write into the composer", () => {
    // The guard owns no draft field at all now: the resolve prompt is a button on the callout,
    // so nothing the guard returns can overwrite what the user typed.
    const decision = resolveConflictGuard({
      trunkConflicts: ["src/a.ts"],
      blocked: false,
      battleMode: true,
    });

    expect(decision).not.toHaveProperty("prefillText");
    expect(Object.keys(decision).sort()).toEqual(["active", "conflictKey", "forceBattleOff"]);
  });
});

describe("resolveBattlePause", () => {
  it("turns Battle off and remembers that it was on", () => {
    expect(
      resolveBattlePause({
        conflictsActive: true,
        battleMode: true,
        battleModeBeforeConflict: undefined,
      }),
    ).toEqual({ battleMode: false, battleModeBeforeConflict: true });
  });

  it("remembers an off switch too, so it is not turned on afterwards", () => {
    expect(
      resolveBattlePause({
        conflictsActive: false,
        battleMode: false,
        battleModeBeforeConflict: false,
      }),
    ).toEqual({ battleMode: false, battleModeBeforeConflict: undefined });
  });

  it("puts the switch back exactly where the user left it", () => {
    expect(
      resolveBattlePause({
        conflictsActive: false,
        battleMode: false,
        battleModeBeforeConflict: true,
      }),
    ).toEqual({ battleMode: true, battleModeBeforeConflict: undefined });
  });

  it("does nothing once the pause is already applied", () => {
    expect(
      resolveBattlePause({
        conflictsActive: true,
        battleMode: false,
        battleModeBeforeConflict: true,
      }),
    ).toBeNull();
  });

  it("does nothing on a clean trunk that never paused", () => {
    expect(
      resolveBattlePause({
        conflictsActive: false,
        battleMode: true,
        battleModeBeforeConflict: undefined,
      }),
    ).toBeNull();
  });

  it("survives a reload mid-pause without losing the remembered position", () => {
    // The remembered value is persisted, so a reload re-runs this with the pause already applied
    // and must not overwrite it with the paused-off value.
    const afterReload = resolveBattlePause({
      conflictsActive: true,
      battleMode: false,
      battleModeBeforeConflict: true,
    });
    expect(afterReload).toBeNull();
    expect(
      resolveBattlePause({
        conflictsActive: false,
        battleMode: false,
        battleModeBeforeConflict: true,
      }),
    ).toEqual({ battleMode: true, battleModeBeforeConflict: undefined });
  });
});

describe("CONFLICT_CALLOUT_DETAIL", () => {
  it("says what clears the pause", () => {
    expect(CONFLICT_CALLOUT_DETAIL).toBe(
      "The files below have unresolved merge conflicts. Battles resume once the trunk is clean.",
    );
  });

  it("leaves the count to the list's heading and the paths to its rows", () => {
    expect(CONFLICT_CALLOUT_DETAIL).not.toMatch(/\d/);
    expect(CONFLICT_CALLOUT_DETAIL).not.toContain("packages/app");
  });
});

describe("canStartBattleOnChat", () => {
  it("allows a battle on a ready chat with a clean trunk", () => {
    expect(canStartBattleOnChat({ status: "ready" })).toBe(true);
    expect(canStartBattleOnChat({ status: "ready", trunkConflicts: [] })).toBe(true);
  });

  it("refuses a battle while conflicts stand", () => {
    expect(canStartBattleOnChat({ status: "ready", trunkConflicts: ["src/a.ts"] })).toBe(false);
  });

  it("refuses a battle on a blocked chat", () => {
    expect(
      canStartBattleOnChat({ status: "blocked", blockedReason: "The trunk is unavailable." }),
    ).toBe(false);
  });
});

function repairSnapshot(
  gitApplication: unknown,
  canRetryResolution = true,
  canDiscardWinner = false,
) {
  return {
    chat: { status: "battle_active" },
    turn: { state: "application_failed", canRetryResolution, canDiscardWinner, gitApplication },
  } as unknown as Parameters<typeof arenaParkedPromotion>[0];
}

describe("arenaParkedPromotion", () => {
  it("reports each parked shape and nothing else", () => {
    expect(
      arenaParkedPromotion(repairSnapshot({ state: "conflicted", conflicts: ["src/a.ts"] })),
    ).toEqual({ kind: "conflicted", conflicts: ["src/a.ts"] });
    expect(
      arenaParkedPromotion(
        repairSnapshot({ state: "review", review: { items: [], planned: [] } }, true, true),
      ),
    ).toEqual({ kind: "review", items: [], planned: [], canDiscard: true });
    expect(
      arenaParkedPromotion(repairSnapshot({ state: "manual", reason: "Switched" }, true, true)),
    ).toEqual({
      kind: "stopped",
      reason: "Switched",
      canRetry: true,
      canDiscard: true,
      partial: false,
    });
    expect(arenaParkedPromotion(repairSnapshot({ state: "failed" }))).toBeNull();
    expect(arenaParkedPromotion(undefined)).toBeNull();
  });

  it("flags a stopped apply that already wrote part of the winner", () => {
    expect(
      arenaParkedPromotion(repairSnapshot({ state: "blocked", partial: {} }, false, true)),
    ).toEqual({ kind: "stopped", canRetry: false, canDiscard: true, partial: true });
  });

  it("stays silent on conflicts once the resolution can no longer be retried", () => {
    expect(
      arenaParkedPromotion(repairSnapshot({ state: "conflicted", conflicts: ["src/a.ts"] }, false)),
    ).toBeNull();
  });
});

describe("conflictRepairDetail", () => {
  it("explains that the merge happened and offers both ways to resolve it", () => {
    const detail = conflictRepairDetail({ conflicts: ["src/a.ts", "src/b.ts"] });
    expect(detail).toBe(
      "The changes were merged into this workspace, with conflicts in the files below. Resolve them yourself or ask an agent — clearing the conflict markers is all that is left. You can keep chatting.",
    );
    expect(detail).not.toContain("src/a.ts");
  });

  it("leaves the file count to the file list", () => {
    expect(conflictRepairDetail({ conflicts: ["src/a.ts"] })).not.toContain("1 file");
  });

  it("names nothing the promotion does not leave behind", () => {
    // One step, ordinary dirty files: no unmerged index to stage, no sequencer to continue.
    const detail = conflictRepairDetail({ conflicts: ["src/a.ts"] });
    expect(detail).not.toContain("cherry-pick");
    expect(detail).not.toContain("git add");
  });
});

describe("resolveConflictGuard with a parked promotion", () => {
  it("pauses battles the same way a conflicted trunk does", () => {
    expect(
      resolveConflictGuard({
        trunkConflicts: null,
        blocked: false,
        battleMode: true,
        parkedPromotion: true,
      }).active,
    ).toBe(true);
  });

  it("leaves battles alone when nothing is parked", () => {
    expect(
      resolveConflictGuard({
        trunkConflicts: null,
        blocked: false,
        battleMode: true,
        parkedPromotion: false,
      }).active,
    ).toBe(false);
  });

  it("turns the switch off while parked and puts it back afterwards", () => {
    // The same pause the trunk guard uses, so the position survives the interruption.
    const paused = resolveBattlePause({
      conflictsActive: true,
      battleMode: true,
      battleModeBeforeConflict: undefined,
    });
    expect(paused).toEqual({ battleMode: false, battleModeBeforeConflict: true });
    expect(
      resolveBattlePause({
        conflictsActive: false,
        battleMode: false,
        battleModeBeforeConflict: true,
      }),
    ).toEqual({ battleMode: true, battleModeBeforeConflict: undefined });
  });
});

describe("conflictResolvePrompt", () => {
  const parked = () => ({ kind: "conflicted", conflicts: ["src/a.ts"] }) as const;

  it("sends the same prompt for both pauses, because both end at the markers", () => {
    // A trunk merge ends in the user's own commit. A parked promotion is already written into
    // the workspace, and the resume reads the markers -- not the index, which it leaves merged,
    // and not a sequencer, which it never opens.
    expect(conflictResolvePrompt()).toBe(CONFLICT_PROMPT);
    expect(conflictResolvePrompt(null)).toBe(CONFLICT_PROMPT);
    expect(conflictResolvePrompt(parked())).toBe(CONFLICT_PROMPT);
  });
});

describe("hidesBattleToggle", () => {
  const readyChat = { chat: { status: "ready" } } as unknown as Parameters<
    typeof hidesBattleToggle
  >[0]["snapshot"];
  const parked = repairSnapshot({ state: "conflicted", conflicts: ["src/a.ts"] });

  it("hides the switch while a single-agent turn runs, so the next send steers it", () => {
    expect(hidesBattleToggle({ snapshot: readyChat, agentRunning: true })).toBe(true);
    expect(hidesBattleToggle({ snapshot: undefined, agentRunning: true })).toBe(true);
  });

  it("brings the switch back once the single agent stops", () => {
    expect(hidesBattleToggle({ snapshot: readyChat, agentRunning: false })).toBe(false);
  });

  it("hides the switch while a parked promotion holds the composer", () => {
    expect(hidesBattleToggle({ snapshot: parked, agentRunning: false })).toBe(true);
  });

  it("keeps a running single agent out of the contestants' controls", () => {
    // Auto Accept reads this to say it applies to both contestants.
    expect(battleHoldsComposer(readyChat)).toBe(false);
    expect(battleHoldsComposer(parked)).toBe(true);
  });
});
