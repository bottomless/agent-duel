import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaRunRequestTimes, arenaRunSegments } from "./run-segments";

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const s = (seconds: number) => T0 + seconds * 1000;

function user(id: string, createdSeconds: number) {
  return { id, role: "user", sessionID: "session-a", time: { created: s(createdSeconds) } };
}

function assistant(
  id: string,
  createdSeconds: number,
  completedSeconds: number | null,
  finish: string | null = "stop",
  sessionID = "session-a",
) {
  return {
    id,
    role: "assistant",
    sessionID,
    time: {
      created: s(createdSeconds),
      ...(completedSeconds === null ? {} : { completed: s(completedSeconds) }),
    },
    ...(finish === null ? {} : { finish }),
  };
}

function run(input: Partial<ArenaRun> = {}): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "complete",
    durationMs: null,
    selectable: true,
    applicable: true,
    canRetry: false,
    startedAt: new Date(s(0)).toISOString(),
    promptMessageID: "prompt",
    ...input,
  };
}

describe("arenaRunSegments", () => {
  it("times each reply sent after the contestant finished as its own request", () => {
    const segments = arenaRunSegments(
      run({
        messages: [
          { id: "earlier-turn", role: "user", sessionID: "session-a", time: { created: s(-600) } },
          user("prompt", 0),
          assistant("a1", 1, 40, "tool-calls"),
          assistant("a2", 40, 90),
          user("reply-1", 300),
          assistant("a3", 301, 330),
          user("reply-2", 900),
          assistant("a4", 901, 905, "tool-calls"),
          assistant("a5", 905, 1_020),
        ],
      }),
    );
    expect(segments).toEqual([90_000, 30_000, 120_000]);
  });

  it("keeps a steer inside the request it redirected", () => {
    const segments = arenaRunSegments(
      run({
        messages: [
          user("prompt", 0),
          // Sent while a step was still streaming.
          assistant("a1", 1, 30, "tool-calls"),
          user("steer-1", 20),
          // Sent in the gap after a tool step, before the next one began.
          assistant("a2", 30, 31, "tool-calls"),
          user("steer-2", 31),
          assistant("a3", 32, 60),
        ],
      }),
    );
    expect(segments).toEqual([60_000]);
  });

  it("leaves the running request untimed and keeps the finished ones", () => {
    const segments = arenaRunSegments(
      run({
        runState: "pending",
        messages: [
          user("prompt", 0),
          assistant("a1", 1, 45),
          user("reply-1", 100),
          assistant("a2", 101, null, null),
        ],
      }),
    );
    expect(segments).toEqual([45_000, null]);
  });

  it("times a reply that has no answer yet as running", () => {
    const segments = arenaRunSegments(
      run({
        runState: "pending",
        messages: [user("prompt", 0), assistant("a1", 1, 45), user("reply-1", 100)],
      }),
    );
    expect(segments).toEqual([45_000, null]);
  });

  it("ends a stopped request at the run's end when its last message never completed", () => {
    const segments = arenaRunSegments(
      run({
        runState: "stopped",
        completedAt: new Date(s(200)).toISOString(),
        messages: [
          user("prompt", 0),
          assistant("a1", 1, 20),
          user("reply-1", 120),
          assistant("a2", 121, null, null),
        ],
      }),
    );
    expect(segments).toEqual([20_000, 80_000]);
  });

  it("times a failed request up to its failed answer", () => {
    const errored = { ...assistant("a2", 61, 75, null), error: { name: "APIError" } };
    const segments = arenaRunSegments(
      run({
        runState: "error",
        completedAt: new Date(s(76)).toISOString(),
        messages: [user("prompt", 0), assistant("a1", 1, 50), user("reply-1", 60), errored],
      }),
    );
    expect(segments).toEqual([50_000, 15_000]);
  });

  it("leaves subagent transcripts and context compaction inside the request", () => {
    const segments = arenaRunSegments(
      run({
        messages: [
          user("prompt", 0),
          assistant("a1", 1, 10),
          { ...user("task", 2), sessionID: "child" },
          assistant("child-1", 3, 9, "stop", "child"),
          user("compact", 10),
          { ...assistant("summary", 10, 12), summary: true },
          assistant("a2", 12, 30),
        ],
        parts: { compact: [{ type: "compaction" }] },
      }),
    );
    expect(segments).toEqual([30_000]);
  });

  it("reports nothing before the run starts", () => {
    expect(arenaRunSegments(run({ startedAt: undefined, messages: [user("prompt", 0)] }))).toEqual(
      [],
    );
  });
});

const requestSeconds = (input: Partial<ArenaRun>) =>
  arenaRunRequestTimes(run(input))?.map((request) => request.durationMs) ?? null;

describe("arenaRunRequestTimes", () => {
  // A stub battle on main: requests of 8.232s, 3.686s and 11.421s under a 23s header. Rounding each
  // request down alone gives 8 + 3 + 11 = 22s.
  const threeRequests = [
    user("prompt", 0),
    assistant("a1", 0.3, 8.232),
    user("reply-1", 20),
    assistant("a2", 20.3, 23.686),
    user("reply-2", 30),
    assistant("a3", 30.3, 41.421),
  ];

  it("splits the engine's total so the requests add up to the header", () => {
    expect(
      requestSeconds({ messages: threeRequests, durationMs: 23_543, priorDurationMs: 12_115 }),
    ).toEqual([8_000, 4_000, 11_000]);
  });

  it("matches the earlier requests to the engine's prior time while the latest one runs", () => {
    expect(
      requestSeconds({
        runState: "pending",
        messages: [...threeRequests.slice(0, 5), assistant("a3", 30.3, null, null)],
        durationMs: null,
        priorDurationMs: 12_115,
      }),
    ).toEqual([8_000, 4_000, null]);
  });

  it("takes the wait before a manual retry out of the retried request alone", () => {
    // The failed answer is not in the snapshot: the prompt's only answer starts 30s after it, and
    // the engine counted 15s for the prompt's two attempts.
    expect(
      requestSeconds({
        messages: [
          user("prompt", 0),
          assistant("retried", 30, 40),
          user("reply-1", 100),
          assistant("a3", 100.2, 110.2),
        ],
        durationMs: 25_100,
        priorDurationMs: 15_000,
      }),
    ).toEqual([15_000, 10_000]);
  });

  it("names the message that began each request", () => {
    expect(
      arenaRunRequestTimes(
        run({ messages: threeRequests, durationMs: 23_543, priorDurationMs: 12_115 }),
      )?.map((request) => request.messageId),
    ).toEqual(["prompt", "reply-1", "reply-2"]);
  });

  it("has nothing to break down for a run with one request", () => {
    expect(
      requestSeconds({ messages: [user("prompt", 0), assistant("a1", 1, 45)], durationMs: 45_000 }),
    ).toBeNull();
  });

  it("leaves a run recorded before the engine kept the earlier requests' time alone", () => {
    expect(requestSeconds({ messages: threeRequests, durationMs: 11_428 })).toBeNull();
  });
});
