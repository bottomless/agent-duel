import { describe, expect, it } from "vitest";
import { appendSubmittedUserMessage, applyStreamEvent, createUserMessage } from "@/types/stream";
import type {
  ArenaComparisonDiff,
  ArenaHistoryItem,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import {
  battleWinnerSide,
  divergenceFilesLabel,
  gitApplicationNotice,
  isResolvingBattleState,
  resolutionRetryDetail,
  resolvingBattleLabels,
  RESOLVING_BATTLE_STATES,
  RESOLVING_BUTTON_LABEL,
} from "./battle-result";
import { canRequestBattleDiff, hasBattleDiff } from "./comparison-visibility";
import { comparisonDiff, threeWayFile } from "./review-fixtures.test-helpers";
import {
  arenaSummaryAnchor,
  pendingArenaPrompt,
  projectPendingArenaPrompt,
  isArenaBattleOnScreen,
  isArenaBattleUnresolved,
  partitionArenaSummaries,
} from "./summary-anchor";

const historyItem = {
  id: "turn-1",
  index: 1,
  state: "complete",
  canonicalUserMessageID: "user-1",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:01:00.000Z",
} as ArenaHistoryItem;

describe("arenaSummaryAnchor", () => {
  it("places the marker after the winning turn and before the next prompt", () => {
    expect(
      arenaSummaryAnchor(historyItem, [
        { id: "user-1", kind: "user_message", messageId: "user-1" },
        { id: "thought-1", kind: "thought" },
        { id: "assistant-1", kind: "assistant_message" },
        { id: "user-2", kind: "user_message", messageId: "user-2" },
      ]),
    ).toBe("assistant-1");
  });

  it("anchors to the final item when the winning turn is last", () => {
    expect(
      arenaSummaryAnchor(historyItem, [
        { id: "user-1", kind: "user_message", messageId: "user-1" },
        { id: "assistant-1", kind: "assistant_message" },
      ]),
    ).toBe("assistant-1");
  });

  it("waits for canonical history when the promoted prompt is not present", () => {
    expect(
      arenaSummaryAnchor(historyItem, [{ id: "local-user", kind: "user_message" }]),
    ).toBeNull();
  });
});

describe("partitionArenaSummaries", () => {
  const older = {
    ...historyItem,
    id: "turn-older",
    resolution: { kind: "vote", vote: "a", appliedSide: "a" },
    identities: { a: { name: "Model A" }, b: { name: "Model B" } },
  } as ArenaHistoryItem;
  const latest = { ...older, id: "turn-latest", index: 2 } as ArenaHistoryItem;

  it("keeps the newest completed battle at the live end of the timeline", () => {
    expect(partitionArenaSummaries([older, latest], false)).toEqual({
      inline: [older],
      live: latest,
    });
  });

  it("returns completed summaries inline while another battle is active", () => {
    expect(partitionArenaSummaries([older, latest], true)).toEqual({
      inline: [older, latest],
      live: null,
    });
  });
});

describe("isArenaBattleUnresolved", () => {
  it("switches to the resolved feed presentation as soon as the vote is recorded", () => {
    const active = {
      chat: { status: "battle_active" },
      turn: { state: "awaiting_vote" },
    } as ArenaSnapshot;
    const applying = {
      chat: { status: "battle_active" },
      turn: {
        state: "applying",
        resolution: { kind: "vote", vote: "b", appliedSide: "b" },
      },
    } as ArenaSnapshot;

    expect(isArenaBattleUnresolved(active)).toBe(true);
    expect(isArenaBattleUnresolved(applying)).toBe(false);
  });
});

describe("isArenaBattleOnScreen", () => {
  const snapshot = (state: string, resolved: boolean, status = "battle_active") =>
    ({
      chat: { status },
      turn: {
        state,
        ...(resolved ? { resolution: { kind: "vote", vote: "b", appliedSide: "b" } } : {}),
      },
    }) as ArenaSnapshot;

  it("holds the panes through the resolution the vote kicks off", () => {
    // The winner's work is not in the chat until the graft and the winner's environment is
    // not reported until after it, so unmounting on the resolution leaves a gap with nothing
    // in it. Every state between the vote and `complete` keeps the panes.
    expect(isArenaBattleOnScreen(snapshot("awaiting_vote", false))).toBe(true);
    expect(isArenaBattleOnScreen(snapshot("early_selected", true))).toBe(true);
    expect(isArenaBattleOnScreen(snapshot("applying", true))).toBe(true);
    expect(isArenaBattleOnScreen(snapshot("canonicalizing", true))).toBe(true);
    expect(isArenaBattleOnScreen(snapshot("cleanup_pending", true))).toBe(true);
  });

  it("hands over once the turn completes", () => {
    expect(isArenaBattleOnScreen(snapshot("complete", true))).toBe(false);
    expect(isArenaBattleOnScreen(snapshot("complete", true, "ready"))).toBe(false);
  });

  it("does not hold the panes for a resolution that needs the user", () => {
    // These are reported by the collapsed summary, which carries the retry affordance.
    expect(isArenaBattleOnScreen(snapshot("application_failed", true))).toBe(false);
    expect(isArenaBattleOnScreen(snapshot("canonicalization_failed", true))).toBe(false);
  });

  it("labels only the side the user chose", () => {
    const applying = {
      state: "applying",
      appliedSide: "b",
      resolution: { kind: "vote", vote: "b", appliedSide: "b" },
    } as unknown as ArenaSnapshot["turn"];
    expect(resolvingBattleLabels(applying)).toEqual({ a: null, b: RESOLVING_BUTTON_LABEL });

    const canonicalizing = {
      state: "canonicalizing",
      appliedSide: "a",
      resolution: { kind: "vote", vote: "a", appliedSide: "a" },
    } as unknown as ArenaSnapshot["turn"];
    expect(resolvingBattleLabels(canonicalizing)).toEqual({ a: RESOLVING_BUTTON_LABEL, b: null });
  });

  it("says the same thing for every state it covers", () => {
    // The button changing copy mid-resolution reads as flicker, not as progress. One label,
    // start to finish, however many phases the daemon moves through underneath it.
    const labels = [...RESOLVING_BATTLE_STATES].map(
      (state) =>
        resolvingBattleLabels({
          state,
          appliedSide: "a",
          resolution: { kind: "vote", vote: "a", appliedSide: "a" },
        } as unknown as ArenaSnapshot["turn"]).a,
    );
    expect(new Set(labels)).toEqual(new Set([RESOLVING_BUTTON_LABEL]));
  });

  it("labels neither side before a vote or after it completes", () => {
    const voting = { state: "awaiting_vote" } as unknown as ArenaSnapshot["turn"];
    const done = {
      state: "complete",
      appliedSide: "a",
    } as unknown as ArenaSnapshot["turn"];
    expect(resolvingBattleLabels(voting)).toEqual({ a: null, b: null });
    expect(resolvingBattleLabels(done)).toEqual({ a: null, b: null });
    expect(resolvingBattleLabels(undefined)).toEqual({ a: null, b: null });
  });

  it("agrees with the states that have button copy", () => {
    for (const state of RESOLVING_BATTLE_STATES) {
      expect(isResolvingBattleState(state)).toBe(true);
      expect(isArenaBattleOnScreen(snapshot(state, true))).toBe(true);
    }
    expect(isResolvingBattleState("complete")).toBe(false);
    expect(isResolvingBattleState(undefined)).toBe(false);
  });
});

describe("hasBattleDiff", () => {
  it("omits an empty patch for identical trees", () => {
    expect(hasBattleDiff(comparisonDiff({ treesEqual: true, files: [], divergence: [] }))).toBe(
      false,
    );
  });

  it("shows shared base changes when the final trees are identical", () => {
    const file = threeWayFile({ file: "main.py", base: "old", a: "new", b: "new" });
    expect(
      hasBattleDiff(
        comparisonDiff({
          treesEqual: true,
          files: [file],
          divergence: [{ file: file.file, status: "identical" }],
        }),
      ),
    ).toBe(true);
  });

  it("shows comparisons when the agents produced different trees", () => {
    expect(hasBattleDiff({ treesEqual: false } as ArenaComparisonDiff)).toBe(true);
  });

  it("waits until the diff is available", () => {
    expect(hasBattleDiff(undefined)).toBe(false);
  });
});

describe("canRequestBattleDiff", () => {
  it("waits for stop reconciliation before requesting a diff", () => {
    expect(canRequestBattleDiff("stopping")).toBe(false);
    expect(canRequestBattleDiff("awaiting_stop_resolution")).toBe(true);
  });

  it("allows normal and terminal comparison states", () => {
    expect(canRequestBattleDiff("awaiting_vote")).toBe(true);
    expect(canRequestBattleDiff("applying")).toBe(true);
    expect(canRequestBattleDiff("complete")).toBe(true);
    expect(canRequestBattleDiff("discarded")).toBe(true);
  });
});

describe("battleWinnerSide", () => {
  it("marks an A or B vote as the winner", () => {
    expect(battleWinnerSide({ ...historyItem, vote: "b", appliedSide: "b" })).toBe("b");
  });

  it("does not mark the applied tie side as a winner", () => {
    expect(battleWinnerSide({ ...historyItem, vote: "tie", appliedSide: "a" })).toBeUndefined();
  });
});

describe("gitApplicationNotice", () => {
  it("leaves a conflicted promotion to the callout that can clear it", () => {
    // Otherwise one conflict lands three times on a screen: header badge, card notice, callout.
    expect(
      gitApplicationNotice({
        ...historyItem,
        appliedSide: "a",
        gitApplication: {
          state: "conflicted",
          conflicts: ["src/app.ts", "src/state.ts"],
        },
      }),
    ).toBeUndefined();
  });

  it("keeps ref carry-over visible when the winner also has conflicts", () => {
    // The conflict itself is the callout's to report. The branches the winner carried are not in
    // it, so suppressing the whole notice would be the one thing that loses them.
    expect(
      gitApplicationNotice({
        ...historyItem,
        appliedSide: "a",
        gitApplication: {
          state: "conflicted",
          conflicts: ["src/app.ts"],
          refs: [{ ref: "refs/heads/carried", action: "created" }],
        },
      }),
    ).toEqual({
      tone: "info",
      title: "Branches updated",
      detail: "Created carried.",
      conflicts: [],
    });
  });

  it("surfaces a preserved result that needs manual application", () => {
    expect(
      gitApplicationNotice({
        ...historyItem,
        gitApplication: {
          state: "manual",
          reason: "The checked-out branch changed during the battle.",
        },
      }),
    ).toMatchObject({
      tone: "warning",
      title: "Git application needs attention",
      detail: "The checked-out branch changed during the battle.",
    });
  });

  it("stays quiet after a successful application", () => {
    expect(
      gitApplicationNotice({
        ...historyItem,
        gitApplication: { state: "applied", resultCommit: "abc123" },
      }),
    ).toBeUndefined();
  });

  it("lists the other refs the winner moved", () => {
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        resultCommit: "abc123",
        refs: [
          { ref: "refs/heads/main", action: "updated" },
          { ref: "refs/tags/v2", action: "created" },
          { ref: "refs/remotes/origin/main", action: "updated" },
          { ref: "refs/heads/old", action: "deleted" },
        ],
      },
    });
    expect(notice).toEqual({
      tone: "info",
      title: "Branches updated",
      detail: "Updated main. Created tag v2. Updated origin/main. Deleted old.",
      conflicts: [],
    });
    // Every non-skipped action renders its own verb; none of them fall through to "undefined".
    expect(notice?.detail).not.toContain("undefined");
  });

  it("says how Arena combined a branch both sides changed, and where the workspace ended", () => {
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        resultCommit: "abc123",
        switchedTo: "feat/studio",
        refs: [
          { ref: "refs/heads/feat/studio", action: "updated", how: "agent_on_yours" },
          {
            ref: "refs/heads/feat/side",
            action: "updated",
            how: "yours_on_agent",
            removed: 2,
            backupRef: "refs/battles/c/turn-0/replaced/heads/feat/side",
          },
        ],
      },
    });
    expect(notice?.detail).toBe(
      "Updated feat/studio: the agent’s commits now follow yours, and this workspace is now on it. " +
        "Updated feat/side: your commits now follow the agent’s version. " +
        "Its 2 old commits are kept at refs/battles/c/turn-0/replaced/heads/feat/side.",
    );
    expect(
      gitApplicationNotice({
        ...historyItem,
        gitApplication: { state: "applied", switchedTo: "arena/turn-2" },
      })?.detail,
    ).toBe("This workspace is now on arena/turn-2.");
  });

  it("warns when a moved ref was skipped and says why", () => {
    expect(
      gitApplicationNotice({
        ...historyItem,
        gitApplication: {
          state: "applied",
          resultCommit: "abc123",
          refs: [
            { ref: "refs/heads/main", action: "updated" },
            {
              ref: "refs/heads/release/2",
              action: "skipped",
              reason: "release/2 moved during the battle.",
            },
          ],
        },
      }),
    ).toEqual({
      tone: "warning",
      title: "Some branches were not updated",
      detail: "Updated main. release/2 moved during the battle.",
      conflicts: [],
    });
  });

  it("clamps a reason carrying git's own error text", () => {
    const long = `feature/x could not be written: ${"cannot lock ref ".repeat(20)}`;
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        resultCommit: "abc123",
        refs: [{ ref: "refs/heads/feature/x", action: "skipped", reason: long }],
      },
    });
    expect(notice?.tone).toBe("warning");
    // The clamp bounds one reason, not the whole notice. This fixture has a single skipped ref,
    // so the whole detail happens to be that one clamped sentence -- see the next test for a
    // fixture with more than one, where the two do not coincide.
    expect(notice?.detail.length).toBeLessThanOrEqual(160);
    expect(notice?.detail.startsWith("feature/x could not be written:")).toBe(true);
    expect(notice?.detail.endsWith("…")).toBe(true);
  });

  it("clamps each skipped reason independently, so the notice itself can exceed 160 characters", () => {
    const long = `feature/x could not be written: ${"cannot lock ref ".repeat(20)}`;
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        resultCommit: "abc123",
        refs: [
          { ref: "refs/heads/feature/x", action: "skipped", reason: long },
          { ref: "refs/heads/feature/y", action: "skipped", reason: long },
        ],
      },
    });
    // Two clamped reasons (each at most 160 characters) joined by a single space: the notice
    // exceeds the per-reason bound, because the bound was never on the notice as a whole.
    expect(notice?.detail.length).toBeGreaterThan(160);
    expect(notice?.detail.length).toBeLessThanOrEqual(160 * 2 + 1);
    expect(notice?.detail.endsWith("…")).toBe(true);
  });
});

describe("Arena resolution retry copy", () => {
  it("counts the conflicted files instead of listing paths the bar cannot fit", () => {
    const detail = resolutionRetryDetail({
      state: "conflicted",
      conflicts: ["packages/app/src/components/sidebar/workspace-meta-row/index.tsx", "src/b.ts"],
    });
    expect(detail).toBe("2 files have unresolved merge conflicts. Resolve each one, then retry.");
    expect(detail).not.toContain("index.tsx");
  });

  it("keeps the single-file wording singular", () => {
    expect(resolutionRetryDetail({ state: "conflicted", conflicts: ["src/a.ts"] })).toBe(
      "1 file has unresolved merge conflicts. Resolve it, then retry.",
    );
  });

  it("asks for nothing but the markers, which are all the retry reads", () => {
    const detail = resolutionRetryDetail({ state: "conflicted", conflicts: ["src/a.ts"] });
    // The promotion writes in one step: no unmerged index to stage, no sequencer to continue.
    expect(detail).not.toContain("`git add`");
    expect(detail).not.toContain("cherry-pick");
  });

  it("still instructs when the conflict list is missing", () => {
    expect(resolutionRetryDetail({ state: "conflicted" })).toBe(
      "Unresolved merge conflicts remain. Resolve each one, then retry.",
    );
  });

  it("does not describe canonicalization recovery as a Git conflict", () => {
    expect(resolutionRetryDetail({ state: "applied" })).toContain("already in this workspace");
    expect(resolutionRetryDetail({ state: "failed" })).toContain("preserved");
  });
});

describe("Arena review copy", () => {
  it("labels the conflicting files with their count", () => {
    expect(divergenceFilesLabel(["src/a.ts"])).toBe("Conflicting files (1)");
    expect(divergenceFilesLabel(["src/a.ts", "src/b.ts"])).toBe("Conflicting files (2)");
  });

  it("leaves a review to the callout, which carries the choices", () => {
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: { state: "review", review: { items: [], planned: [] } },
    });
    expect(notice).toBeUndefined();
  });

  it("names where a ref write kept the commits it dropped", () => {
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        refs: [
          {
            ref: "refs/heads/feat",
            action: "updated",
            backupRef: "refs/agent-duel/t/replaced/heads/feat",
            removed: 2,
          },
        ],
      },
    });
    expect(notice?.detail).toContain(
      "2 old commits are kept at refs/agent-duel/t/replaced/heads/feat",
    );
  });
});

describe("Arena discard recovery copy", () => {
  it("explains that discarded winning changes were never applied", () => {
    expect(
      gitApplicationNotice({ ...historyItem, gitApplication: { state: "discarded" } }),
    ).toEqual({
      tone: "info",
      title: "Winning changes discarded",
      detail: "The winning agent’s changes were not applied.",
      conflicts: [],
    });
  });

  it("names the ref holding what the discard threw away", () => {
    const notice = gitApplicationNotice({
      ...historyItem,
      gitApplication: {
        state: "applied",
        discardedRef: "refs/battles/chat-1/turn-0/public-safety",
      },
    });
    expect(notice?.tone).toBe("info");
    expect(notice?.title).toBe("Your changes were set aside");
    expect(notice?.detail).toContain("refs/battles/chat-1/turn-0/public-safety");
  });

  it("stays silent on an ordinary application", () => {
    expect(
      gitApplicationNotice({ ...historyItem, gitApplication: { state: "applied" } }),
    ).toBeUndefined();
  });
});

describe("pendingArenaPrompt", () => {
  const snapshot = {
    chat: { status: "ready" },
    turn: { ...historyItem, prompt: "Keep this prompt visible" },
  } as ArenaSnapshot;
  const active = {
    ...snapshot,
    chat: { ...snapshot.chat, status: "battle_active" },
    turn: { ...snapshot.turn!, state: "awaiting_vote", resolution: undefined },
  } as ArenaSnapshot;
  const canonicalPrompt = createUserMessage({
    messageId: "user-1",
    text: snapshot.turn!.prompt,
    timestamp: new Date(historyItem.createdAt),
    timelineCursor: { epoch: "canonical", seq: 2 },
  });

  function observeBattle() {
    const pending = pendingArenaPrompt({ snapshot: active, streamItems: [], pendingTurnId: null });
    expect(pending).toBe(active.turn);
    return pending!.id;
  }

  it("keeps an observed battle prompt until its canonical row arrives", () => {
    const pendingTurnId = observeBattle();
    expect(pendingArenaPrompt({ snapshot, streamItems: [], pendingTurnId })).toBe(snapshot.turn);
    expect(
      pendingArenaPrompt({ snapshot, streamItems: [canonicalPrompt], pendingTurnId }),
    ).toBeNull();
    expect(
      pendingArenaPrompt({
        snapshot,
        streamItems: [{ id: "user-1", kind: "user_message" }],
        pendingTurnId,
      }),
    ).toBeNull();
  });

  it("keeps the handoff through vote resolution for a winner or a tie", () => {
    for (const vote of ["a", "tie"] as const) {
      const pendingTurnId = observeBattle();
      const resolution = { kind: "vote" as const, vote, appliedSide: "a" as const };
      const resolving = {
        ...active,
        turn: { ...active.turn!, state: "canonicalizing" as const, resolution },
      };
      const pending = pendingArenaPrompt({ snapshot: resolving, streamItems: [], pendingTurnId });
      expect(pending).toBe(resolving.turn);
      const completed = { ...snapshot, turn: { ...snapshot.turn!, resolution } };
      expect(
        pendingArenaPrompt({
          snapshot: completed,
          streamItems: [],
          pendingTurnId: pending!.id,
        }),
      ).toBe(completed.turn);
    }
  });

  it("keeps the prompt through optimistic submission and the server's accepted echo", () => {
    const pendingTurnId = observeBattle();
    const previous = createUserMessage({
      messageId: "previous-prompt",
      text: "Previous turn",
      timestamp: new Date("2026-08-11T23:59:00.000Z"),
      timelineCursor: { epoch: "previous", seq: 1 },
    });
    const followUp = createUserMessage({
      clientMessageId: "queued-follow-up",
      text: "Continue in single-agent mode",
      timestamp: new Date("2026-08-12T00:02:00.000Z"),
    });
    expect(projectPendingArenaPrompt([previous], snapshot.turn!).map((item) => item.id)).toEqual([
      previous.id,
      "arena-prompt:turn-1",
    ]);
    const stream = appendSubmittedUserMessage({ tail: [previous], head: [], message: followUp });
    expect(projectPendingArenaPrompt(stream.tail, snapshot.turn!).map((item) => item.id)).toEqual([
      previous.id,
      "arena-prompt:turn-1",
      followUp.id,
    ]);
    expect(
      pendingArenaPrompt({
        snapshot,
        streamItems: [...stream.head, ...stream.tail],
        pendingTurnId,
      }),
    ).toBe(snapshot.turn);
    const accepted = applyStreamEvent({
      tail: stream.tail,
      head: stream.head,
      event: {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          clientMessageId: "queued-follow-up",
          messageId: "queued-follow-up",
          text: followUp.text,
        },
      },
      timestamp: new Date("2026-08-12T00:02:00.100Z"),
      timelineCursor: { epoch: "previous", seq: 2 },
      source: "live",
    });
    const items = [...accepted.tail, ...accepted.head];
    const laterFollowUp = createUserMessage({
      clientMessageId: "second-follow-up",
      text: "Another follow-up",
      timestamp: new Date("2026-08-12T00:03:00.000Z"),
    });
    expect(
      projectPendingArenaPrompt([...items, laterFollowUp], snapshot.turn!).map((item) => item.id),
    ).toEqual([previous.id, "arena-prompt:turn-1", followUp.id, laterFollowUp.id]);
    expect(projectPendingArenaPrompt(items, null)).toBe(items);
    expect(projectPendingArenaPrompt(items, active.turn!)).toBe(items);
    expect(pendingArenaPrompt({ snapshot, streamItems: items, pendingTurnId })).toBe(snapshot.turn);
    expect(
      pendingArenaPrompt({ snapshot, streamItems: [...items, canonicalPrompt], pendingTurnId }),
    ).toBeNull();
  });

  it("keeps the previous answer before the prompt even if its live timestamp was refreshed", () => {
    const previous = createUserMessage({
      messageId: "previous",
      text: "Previous prompt",
      timestamp: new Date("2026-08-11T23:59:00Z"),
    });
    const stream = applyStreamEvent({
      tail: [previous],
      head: [],
      event: {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", messageId: "previous-answer", text: "Previous answer" },
      },
      timestamp: new Date("2026-08-12T00:02:00Z"),
      source: "live",
    });
    const items = [...stream.tail, ...stream.head];
    expect(projectPendingArenaPrompt(items, snapshot.turn!).map((item) => item.id)).toEqual([
      previous.id,
      items[1].id,
      "arena-prompt:turn-1",
    ]);
  });

  it("removes the projected prompt on an index-only update without touching the live head", () => {
    const head = [
      createUserMessage({
        clientMessageId: "follow-up",
        text: "Continue",
        timestamp: new Date("2026-08-12T00:02:00.000Z"),
      }),
    ];
    const tail = [
      createUserMessage({
        messageId: "later-winner-reply",
        text: "A later reply within the battle",
        timestamp: new Date("2026-08-12T00:00:30.000Z"),
        timelineCursor: { epoch: "winner", seq: 10 },
      }),
    ];
    const input = {
      snapshot,
      streamItems: [...tail, ...head],
      pendingTurnId: observeBattle(),
      timelineRange: { epoch: "winner", startSeq: 10 },
    };
    const before = projectPendingArenaPrompt(tail, pendingArenaPrompt(input));
    expect([...before, ...head].map((item) => item.id)).toEqual([
      "arena-prompt:turn-1",
      "later-winner-reply",
      "follow-up",
    ]);
    expect(before[0]).toEqual({
      kind: "user_message",
      id: "arena-prompt:turn-1",
      text: snapshot.turn!.prompt,
      timestamp: new Date(historyItem.createdAt),
    });
    const after = projectPendingArenaPrompt(
      tail,
      pendingArenaPrompt({
        ...input,
        promptIndex: {
          epoch: "winner",
          prompts: [
            { messageId: "user-1", seq: 1, timestamp: historyItem.createdAt, preview: "prompt" },
          ],
        },
      }),
    );
    expect(after).toBe(tail);
    expect([...after, ...head].map((item) => item.id)).toEqual(["later-winner-reply", "follow-up"]);
    expect(tail).toHaveLength(1);
    expect(head).toHaveLength(1);
  });

  it("replaces the presentation row with canonical history without persisting it", () => {
    const tail: (typeof canonicalPrompt)[] = [];
    const pendingTurnId = observeBattle();
    expect(
      projectPendingArenaPrompt(
        tail,
        pendingArenaPrompt({ snapshot, streamItems: tail, pendingTurnId }),
      ),
    ).toHaveLength(1);
    expect(tail).toEqual([]);
    const loaded = [canonicalPrompt];
    expect(
      projectPendingArenaPrompt(
        loaded,
        pendingArenaPrompt({ snapshot, streamItems: loaded, pendingTurnId }),
      ),
    ).toBe(loaded);
    expect(
      projectPendingArenaPrompt(
        tail,
        pendingArenaPrompt({ snapshot, streamItems: tail, pendingTurnId: null }),
      ),
    ).toBe(tail);
  });

  it("finishes a retained handoff when reconnect loads a page after the indexed prompt", () => {
    const pendingTurnId = observeBattle();
    const streamItems = Array.from({ length: 40 }, (_, index) => ({
      id: `winner-tool-${index}`,
      kind: "tool_call" as const,
    }));
    const timelineRange = { epoch: "winner-epoch", startSeq: 7 };
    const promptIndex = {
      epoch: "winner-epoch",
      prompts: [
        { seq: 1, messageId: "user-1", timestamp: historyItem.createdAt, preview: "prompt" },
      ],
    };
    expect(
      pendingArenaPrompt({ snapshot, streamItems, pendingTurnId, timelineRange, promptIndex }),
    ).toBeNull();
    // A missing index, a different epoch, or a later accepted prompt proves nothing.
    for (const index of [
      undefined,
      { ...promptIndex, epoch: "previous-epoch" },
      { ...promptIndex, prompts: [{ ...promptIndex.prompts[0], messageId: "follow-up" }] },
    ]) {
      expect(
        pendingArenaPrompt({
          snapshot,
          streamItems,
          pendingTurnId,
          timelineRange,
          promptIndex: index,
        }),
      ).toBe(snapshot.turn);
    }
    // If the prompt belongs inside the current window, keep waiting for its actual row.
    expect(
      pendingArenaPrompt({
        snapshot,
        streamItems,
        pendingTurnId,
        promptIndex,
        timelineRange: { epoch: "winner-epoch", startSeq: 1 },
      }),
    ).toBe(snapshot.turn);
  });

  it("does not start a handoff on reload, including an empty or paginated history", () => {
    const newerPage = Array.from({ length: 40 }, (_, index) => ({
      id: `tool-${index}`,
      kind: "tool_call" as const,
    }));
    for (const streamItems of [[], newerPage, [canonicalPrompt]]) {
      expect(pendingArenaPrompt({ snapshot, streamItems, pendingTurnId: null })).toBeNull();
    }
  });

  it("does not resurrect a finished handoff when its prompt leaves the loaded page", () => {
    const finished = pendingArenaPrompt({
      snapshot,
      streamItems: [canonicalPrompt],
      pendingTurnId: observeBattle(),
    });
    expect(finished).toBeNull();
    expect(
      pendingArenaPrompt({
        snapshot,
        streamItems: [{ id: "winner-tool", kind: "tool_call" }],
        pendingTurnId: finished?.id ?? null,
      }),
    ).toBeNull();
  });

  it("clears the handoff when the chat or turn changes, or the battle is discarded", () => {
    const pendingTurnId = observeBattle();
    expect(pendingArenaPrompt({ snapshot: undefined, streamItems: [], pendingTurnId })).toBeNull();
    for (const turn of [
      { ...snapshot.turn!, id: "another-turn" },
      { ...snapshot.turn!, state: "discarded" as const },
      { ...snapshot.turn!, canonicalUserMessageID: undefined },
    ]) {
      expect(
        pendingArenaPrompt({ snapshot: { ...snapshot, turn }, streamItems: [], pendingTurnId }),
      ).toBeNull();
    }
  });
});
