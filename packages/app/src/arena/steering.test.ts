import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaQueuedSteerAttachments, arenaQueuedSteering, arenaToolOutput } from "./steering";

function running(): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "pending",
    durationMs: null,
    selectable: false,
    applicable: false,
    startedAt: "2026-10-05T12:00:00Z",
    promptMessageID: "prompt",
    messages: [
      { id: "prompt", role: "user" },
      { id: "working", role: "assistant", parentID: "prompt" },
      { id: "steer", role: "user" },
    ],
    parts: {
      working: [
        {
          id: "tool",
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "sleep 60", description: "Wait for the preview" },
            metadata: { output: "Starting preview…" },
            time: { start: 1000 },
          },
        },
      ],
      steer: [{ type: "text", text: "Can I see the preview?" }],
    },
  };
}

describe("queued Arena steering", () => {
  it("keeps a steer pending while an earlier command runs", () => {
    const run = running();
    expect(arenaQueuedSteering(run)).toEqual([
      { id: "steer", text: "Can I see the preview?", images: [], attachments: [] },
    ]);
  });

  it("queues a steer that carries only an image, and keeps a file's text out of the message", () => {
    const run = running();
    run.messages?.push({ id: "image-only", role: "user" }, { id: "with-file", role: "user" });
    run.parts = {
      ...run.parts,
      "image-only": [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }],
      "with-file": [
        { type: "text", text: "Use this config." },
        {
          type: "text",
          text: "SECRET_FILE_CONTENTS",
          metadata: { arenaAttachment: { label: "notes.md", kind: "file" } },
        },
      ],
    };
    const queued = arenaQueuedSteering(run);
    expect(queued.map((message) => message.id)).toEqual(["steer", "image-only", "with-file"]);
    expect(queued[1]?.text).toBe("");
    expect(arenaQueuedSteerAttachments(queued[1]!)).toBe("1 image");
    expect(queued[2]?.text).toBe("Use this config.");
    expect(arenaQueuedSteerAttachments(queued[2]!)).toBe("notes.md");
    expect(JSON.stringify(queued)).not.toContain("SECRET_FILE_CONTENTS");
  });

  it("does not mistake a later assistant message for delivery if it still answers the old prompt", () => {
    const run = running();
    run.messages?.push({ id: "old-continuation", role: "assistant", parentID: "prompt" });
    expect(arenaQueuedSteering(run).map((message) => message.id)).toEqual(["steer"]);
  });

  it("clears all queued messages included in the next model iteration", () => {
    const run = running();
    run.messages?.push({ id: "steer-2", role: "user" });
    run.parts = { ...run.parts, "steer-2": [{ type: "text", text: "Use port 3000." }] };
    expect(arenaQueuedSteering(run).map((message) => message.id)).toEqual(["steer", "steer-2"]);
    run.messages?.push({ id: "new-answer", role: "assistant", parentID: "steer-2" });
    expect(arenaQueuedSteering(run)).toEqual([]);
  });

  it("leaves ended runs with transcript history instead of a live queue", () => {
    const run = { ...running(), runState: "stopped" as const };
    expect(arenaQueuedSteering(run)).toEqual([]);
  });

  it("prefers final output over running tool output", () => {
    expect(arenaToolOutput({ output: "done", metadata: { output: "working" } })).toBe("done");
    expect(arenaToolOutput({ status: "running", metadata: { output: "working" } })).toBe("working");
  });
});
