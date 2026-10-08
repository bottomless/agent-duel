import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaReasoningPartIsActive, arenaThreadMessages } from "./run-thread-selection";

function run(messages: unknown[], promptMessageID?: string): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "complete",
    durationMs: 10,
    selectable: true,
    applicable: true,
    // Dispatched: every run here has had its prompt sent. A run without `startedAt` has not,
    // and is covered on its own below.
    startedAt: "2026-09-04T12:00:00.000Z",
    messages,
    ...(promptMessageID ? { promptMessageID } : {}),
  };
}

describe("arenaThreadMessages", () => {
  it("shows nothing for a run whose prompt has not been dispatched", () => {
    // The session is a fork, so before its prompt lands it holds the previous turn and nothing
    // of this one. Guessing from the newest user message would put the last battle's winning
    // reply in the pane, labelled as this turn's work, until the real boundary arrives.
    const forked = {
      ...run([
        { id: "m1", role: "user", content: "the previous turn's prompt" },
        { id: "m2", role: "assistant", content: "the previous winner's reply" },
      ]),
      startedAt: undefined,
      promptMessageID: undefined,
    } as ArenaRun;
    expect(arenaThreadMessages(forked)).toEqual([]);
  });

  it("shows only assistant messages after the battle prompt", () => {
    const result = arenaThreadMessages(
      run(
        [
          { id: "old-user", role: "user" },
          { id: "old-agent", role: "assistant" },
          { id: "battle-prompt", role: "user" },
          { id: "new-agent", role: "assistant" },
        ],
        "battle-prompt",
      ),
    );

    expect(result).toEqual([{ id: "new-agent", role: "assistant" }]);
  });

  it("waits for the exact prompt boundary instead of exposing prior history", () => {
    const result = arenaThreadMessages(
      run(
        [
          { id: "old-user", role: "user" },
          { id: "old-agent", role: "assistant" },
        ],
        "battle-prompt",
      ),
    );

    expect(result).toEqual([]);
  });

  it("uses the final user message for legacy runs without a prompt id", () => {
    const result = arenaThreadMessages(
      run([
        { id: "old-agent", role: "assistant" },
        { id: "battle-prompt", role: "user" },
        { id: "new-agent", role: "assistant" },
      ]),
    );

    expect(result).toEqual([{ id: "new-agent", role: "assistant" }]);
  });

  it("keeps follow-up user messages inside the contestant timeline", () => {
    const result = arenaThreadMessages(
      run(
        [
          { id: "battle-prompt", role: "user" },
          { id: "first-agent", role: "assistant" },
          { id: "follow-up", role: "user" },
          { id: "second-agent", role: "assistant" },
        ],
        "battle-prompt",
      ),
    );

    expect(result).toEqual([
      { id: "first-agent", role: "assistant" },
      { id: "follow-up", role: "user" },
      { id: "second-agent", role: "assistant" },
    ]);
  });

  it("does not mistake a subagent prompt for the legacy battle boundary", () => {
    const parent = { id: "parent", role: "assistant", sessionID: "session-a" };
    const child = { id: "child-prompt", role: "user", sessionID: "child" };
    expect(
      arenaThreadMessages(
        run([{ id: "prompt", role: "user", sessionID: "session-a" }, parent, child]),
      ),
    ).toEqual([parent, child]);
  });
});

describe("arenaReasoningPartIsActive", () => {
  it("animates only unfinished reasoning while the run is pending", () => {
    const pendingRun = { ...run([]), runState: "pending" as const };

    expect(
      arenaReasoningPartIsActive(pendingRun, {
        type: "reasoning",
        text: "still thinking",
        time: { start: 1 },
      }),
    ).toBe(true);
    expect(
      arenaReasoningPartIsActive(pendingRun, {
        type: "reasoning",
        text: "finished thought",
        time: { start: 1, end: 2 },
      }),
    ).toBe(false);
  });

  it("does not animate reasoning after the run finishes", () => {
    expect(
      arenaReasoningPartIsActive(run([]), {
        type: "reasoning",
        text: "finished thought",
        time: { start: 1 },
      }),
    ).toBe(false);
  });
});
