import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveStreamTurnTiming } from "./turn-time";
import type { StreamItem } from "@/types/stream";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

const appliedBattle: ArenaHistoryItem = {
  id: "battle",
  index: 1,
  state: "complete",
  appliedSide: "b",
  canonicalUserMessageID: "msg_1",
  canonicalLastMessageID: "msg_3",
  appliedDurationMs: 93_000,
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:02:00.000Z",
};

function user(id: string, timestamp: Date): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp,
  };
}

function assistant(
  id: string,
  timestamp: Date,
  text = id,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp,
  };
}

describe("deriveStreamTurnTiming", () => {
  it("uses the applied winner's active time after Retry, across hydration and history reload", () => {
    const prompt = { ...user("u1", new Date(appliedBattle.createdAt)), messageId: "msg_1" };
    const answer = {
      ...assistant("a1", new Date("2026-05-15T00:01:56.000Z")),
      messageId: "msg_3",
    };
    for (const stream of [
      { tail: [prompt], head: [answer] },
      { tail: [prompt, answer], head: [] },
      // A loaded page can omit the prompt.
      { tail: [answer], head: [] },
    ]) {
      const timing = deriveStreamTurnTiming({
        ...stream,
        isTurnActive: false,
        activeTurnStartedAt: null,
        arenaHistory: [appliedBattle],
      });
      assert.deepEqual(timing.byItemId.get("a1"), {
        completedAt: answer.timestamp,
        durationMs: 93_000,
      });
      assert.equal(timing.runningStartedAt, null);
    }
  });

  it("starts elapsed time from the submitted prompt", () => {
    const submittedAt = new Date("2026-05-15T00:00:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
      tail: [],
      head: [user("submitted", submittedAt)],
    });

    assert.equal(timing.runningStartedAt, submittedAt);
  });

  it("keeps a later single-agent turn's timestamps and running timer", () => {
    const submittedAt = new Date("2026-05-15T00:05:00.000Z");
    const completedAt = new Date("2026-05-15T00:05:07.000Z");
    const tail = [
      { ...user("winner-prompt", new Date(appliedBattle.createdAt)), messageId: "msg_1" },
      { ...assistant("winner", new Date("2026-05-15T00:01:56.000Z")), messageId: "msg_3" },
      { ...user("ordinary-prompt", submittedAt), messageId: "msg_4" },
    ];
    const arenaHistory = [appliedBattle];
    const head = [{ ...assistant("ordinary", completedAt), messageId: "msg_5" }];
    const active = deriveStreamTurnTiming({
      tail,
      head,
      arenaHistory,
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
    });
    assert.equal(active.runningStartedAt, submittedAt);
    assert.equal(active.byItemId.get("winner")?.durationMs, 93_000);
    assert.equal(active.byItemId.has("ordinary"), false);
    const delta = deriveStreamTurnTiming({
      tail,
      head: [{ ...head[0], text: "more" }],
      arenaHistory,
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
    });
    assert.equal(delta.byItemId, active.byItemId);
    const completed = deriveStreamTurnTiming({
      tail,
      head,
      arenaHistory,
      isTurnActive: false,
      activeTurnStartedAt: null,
    });
    assert.deepEqual(completed.byItemId.get("ordinary"), { completedAt, durationMs: 7000 });
    assert.equal(completed.byItemId.get("winner")?.durationMs, 93_000);
  });

  it("updates a late duration and retains timestamp timing when no recorded duration exists", () => {
    const tail = [
      { ...user("u1", new Date(appliedBattle.createdAt)), messageId: "msg_1" },
      { ...assistant("a1", new Date("2026-05-15T00:01:56.000Z")), messageId: "msg_3" },
    ];
    const derive = (arenaHistory: ArenaHistoryItem[]) =>
      deriveStreamTurnTiming({
        tail,
        head: [],
        arenaHistory,
        isTurnActive: false,
        activeTurnStartedAt: null,
      });
    assert.equal(
      derive([{ ...appliedBattle, appliedDurationMs: undefined }]).byItemId.get("a1")?.durationMs,
      116_000,
    );
    assert.equal(derive([appliedBattle]).byItemId.get("a1")?.durationMs, 93_000);
    assert.equal(
      derive([{ ...appliedBattle, appliedDurationMs: 0 }]).byItemId.get("a1")?.durationMs,
      0,
    );
  });

  it("uses the last user message as the running turn start", () => {
    const firstUserAt = new Date("2026-05-15T00:00:00.000Z");
    const secondUserAt = new Date("2026-05-15T00:01:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: secondUserAt,
      tail: [
        user("u1", firstUserAt),
        assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
        user("u2", secondUserAt),
      ],
      head: [assistant("a2", new Date("2026-05-15T00:01:04.000Z"))],
    });

    assert.equal(timing.runningStartedAt, secondUserAt);
    assert.equal(timing.byItemId.has("a2"), false);
  });

  it("derives completed turn timing from user and assistant item timestamps", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const assistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", assistantAt),
        user("u2", new Date("2026-05-15T00:01:00.000Z")),
      ],
      head: [],
    });

    assert.deepEqual(timing.byItemId.get("a1"), {
      completedAt: assistantAt,
      durationMs: 7000,
    });
  });

  it("maps multiple assistant chunks in one turn to the same timing", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const firstAssistantAt = new Date("2026-05-15T00:00:03.000Z");
    const lastAssistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", firstAssistantAt),
        assistant("a2", lastAssistantAt),
      ],
      head: [],
    });

    const expected = {
      completedAt: lastAssistantAt,
      durationMs: 7000,
    };
    assert.deepEqual(timing.byItemId.get("a1"), expected);
    assert.deepEqual(timing.byItemId.get("a2"), expected);
  });

  it("preserves the completion timestamp when a canonical turn has no visible prompt", () => {
    const firstTurnAt = new Date("2026-05-15T00:00:00.000Z");
    const hiddenPromptTurnAt = new Date("2026-05-15T00:01:07.000Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", firstTurnAt), turnId: "turn-1" },
        {
          ...assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
          turnId: "turn-1",
        },
        {
          ...assistant("hidden-prompt-a1", new Date("2026-05-15T00:01:03.000Z")),
          turnId: "turn-2",
        },
        { ...assistant("hidden-prompt-a2", hiddenPromptTurnAt), turnId: "turn-2" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byItemId.get("hidden-prompt-a2"), {
      completedAt: hiddenPromptTurnAt,
      durationMs: null,
    });
  });

  it("keeps the timing map identity while a streamed delta grows the live head", () => {
    const tail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const derive = (text: string, at: string) =>
      deriveStreamTurnTiming({
        isTurnActive: true,
        activeTurnStartedAt: tail[2]?.timestamp ?? null,
        tail,
        head: [assistant("a2", new Date(at), text)],
      });

    const first = derive("one", "2026-05-15T00:01:04.000Z");
    const second = derive("one two", "2026-05-15T00:01:05.000Z");

    assert.equal(second.byItemId, first.byItemId);
    assert.deepEqual(first.byItemId.get("a1"), {
      completedAt: tail[1]?.timestamp,
      durationMs: 7000,
    });
    assert.equal(first.byItemId.has("a2"), false);
  });

  it("keeps the timing map identity when the head closed the tail's open turn", () => {
    const lastTailAt = new Date("2026-05-15T00:00:07.000Z");
    const tail = [user("u1", new Date("2026-05-15T00:00:00.000Z")), assistant("a1", lastTailAt)];
    const derive = (text: string, at: string) =>
      deriveStreamTurnTiming({
        isTurnActive: true,
        activeTurnStartedAt: null,
        tail,
        head: [
          user("u2", new Date("2026-05-15T00:01:00.000Z")),
          assistant("a2", new Date(at), text),
        ],
      });

    const first = derive("one", "2026-05-15T00:01:04.000Z");
    const second = derive("one two", "2026-05-15T00:01:05.000Z");

    assert.equal(second.byItemId, first.byItemId);
    assert.deepEqual(first.byItemId.get("a1"), {
      completedAt: lastTailAt,
      durationMs: 7000,
    });
  });

  it("produces a new timing map when the streamed turn completes", () => {
    const tail = [user("u1", new Date("2026-05-15T00:00:00.000Z"))];
    const completedAt = new Date("2026-05-15T00:00:09.000Z");
    const head = [assistant("a1", completedAt)];

    const active = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
    });
    const completed = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head,
    });

    assert.notEqual(completed.byItemId, active.byItemId);
    assert.equal(active.byItemId.has("a1"), false);
    assert.deepEqual(completed.byItemId.get("a1"), { completedAt, durationMs: 9000 });
  });

  it("derives fresh timing when the tail itself changes", () => {
    const firstTail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const secondTail = [...firstTail, assistant("a2", new Date("2026-05-15T00:01:03.000Z"))];
    const derive = (tail: StreamItem[]) =>
      deriveStreamTurnTiming({ isTurnActive: false, activeTurnStartedAt: null, tail, head: [] });

    const first = derive(firstTail);
    const second = derive(secondTail);

    assert.notEqual(second.byItemId, first.byItemId);
    assert.equal(first.byItemId.has("a2"), false);
    assert.deepEqual(second.byItemId.get("a2"), {
      completedAt: secondTail[3]?.timestamp,
      durationMs: 3000,
    });
  });
});

it("times a heartbeat that ends with tools and no assistant text", () => {
  const trigger: StreamItem = {
    kind: "tool_call",
    id: "trigger",
    timestamp: new Date("2026-05-15T00:00:00Z"),
    turnId: "heartbeat",
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: "trigger",
        name: "heartbeat",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "Check progress" },
      },
    },
  };
  const tool: StreamItem = { ...trigger, id: "last", timestamp: new Date("2026-05-15T00:00:05Z") };
  const timing = deriveStreamTurnTiming({
    tail: [trigger, tool],
    head: [],
    isTurnActive: false,
    activeTurnStartedAt: null,
  });
  assert.equal(timing.byItemId.get("last")?.durationMs, 5000);
});
