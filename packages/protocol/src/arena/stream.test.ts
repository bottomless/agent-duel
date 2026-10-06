import { describe, expect, it } from "vitest";
import { applyArenaChanges, ArenaStreamMismatch } from "./stream.js";
import { ArenaSnapshotSchema } from "./rpc-schemas.js";

function fixture() {
  return ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "battle_active",
      canonicalSessionID: "canonical",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    history: [],
    events: [],
    runs: ["a", "b"].map((side) => ({
      id: side,
      side,
      sessionID: side,
      descendantSessionIDs: [],
      worktree: "/tmp/" + side,
      worktreeName: side,
      worktreeActive: true,
      runState: "pending",
      durationMs: null,
      selectable: false,
      applicable: false,
      messages: [{ id: "m", sessionID: side, role: "assistant" }],
      parts: { m: [{ id: "p", messageID: "m", sessionID: side, type: "text", text: "hello" }] },
    })),
  });
}

describe("Arena push changes", () => {
  it("appends text at its expected position without replacing the other run", () => {
    const before = fixture();
    const after = applyArenaChanges(before, [
      { kind: "text", runId: "a", messageId: "m", partId: "p", offset: 5, text: " world" },
    ]);
    expect(after.runs[0].parts?.m[0]).toEqual({
      id: "p",
      messageID: "m",
      sessionID: "a",
      type: "text",
      text: "hello world",
    });
    expect(after.runs[1]).toBe(before.runs[1]);
    expect(after.runs[0].messages).toBe(before.runs[0].messages);
    expect(before.runs[0].parts?.m[0]).toMatchObject({ text: "hello" });
  });
  it("requires resynchronization instead of dropping a missing text range", () => {
    expect(() =>
      applyArenaChanges(fixture(), [
        { kind: "text", runId: "a", messageId: "m", partId: "p", offset: 9, text: "!" },
      ]),
    ).toThrow(ArenaStreamMismatch);
  });
  it("upserts final parts and removes messages together with their parts", () => {
    const after = applyArenaChanges(fixture(), [
      {
        kind: "part",
        runId: "a",
        part: { id: "p", messageID: "m", sessionID: "a", type: "text", text: "complete" },
      },
      { kind: "remove_message", runId: "b", messageId: "m" },
    ]);
    expect(after.runs[0].parts?.m).toHaveLength(1);
    expect(after.runs[0].parts?.m[0]).toMatchObject({ text: "complete" });
    expect(after.runs[1].messages).toEqual([]);
    expect(after.runs[1].parts).toEqual({});
  });
  it("preserves transcripts when state changes and rejects a different run session", () => {
    const before = fixture();
    const state = {
      ...before,
      runs: before.runs.map((run) =>
        Object.assign({}, run, {
          messages: undefined,
          parts: undefined,
          runState: "complete" as const,
        }),
      ),
    };
    const after = applyArenaChanges(before, [{ kind: "state", snapshot: state }]);
    expect(after.runs[0].parts).toBe(before.runs[0].parts);
    expect(after.runs[0].terminal).toBe("complete");
    const other = {
      ...state,
      runs: state.runs.map((run) => Object.assign({}, run, { sessionID: "other" })),
    };
    expect(() => applyArenaChanges(before, [{ kind: "state", snapshot: other }])).toThrow(
      ArenaStreamMismatch,
    );
  });
  it("does not merge descendant transcript records into the root run", () => {
    expect(() =>
      applyArenaChanges(fixture(), [
        { kind: "message", runId: "a", message: { id: "child", sessionID: "descendant" } },
      ]),
    ).toThrow(ArenaStreamMismatch);
  });
});
