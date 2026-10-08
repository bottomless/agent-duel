import { describe, expect, it } from "vitest";
import { projectArenaSessions, arenaSubagentRunState } from "./subagents";

describe("projectArenaSessions", () => {
  it("keeps interleaved child activity with its named delegation", () => {
    const task = {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { description: "Find vote storage" },
        metadata: { sessionId: "child" },
      },
    };
    const parent = { id: "parent", role: "assistant", sessionID: "root" };
    const child = { id: "child-tool", role: "assistant", sessionID: "child" };
    const resumed = { id: "resumed", role: "assistant", sessionID: "root" };
    const sessions = projectArenaSessions({
      sessionID: "root",
      messages: [parent, child, resumed],
      parts: { parent: [task] },
    });

    expect(sessions.root.messages).toEqual([parent, resumed]);
    expect(sessions.byTask.get(task)).toEqual({
      id: "child",
      name: "Find vote storage",
      messages: [child],
      task,
    });
    expect(sessions.unattached).toEqual([]);
  });

  it("keeps a child visible before its task metadata arrives", () => {
    const child = { id: "child-message", role: "assistant", sessionID: "child" };
    const sessions = projectArenaSessions({ sessionID: "root", messages: [child] });
    expect(sessions.root.messages).toEqual([]);
    expect(sessions.unattached.map((session) => session.messages)).toEqual([[child]]);
  });

  it("retains nested delegation and updates resumed tasks without duplicating the transcript", () => {
    const first = {
      type: "tool",
      tool: "task",
      state: { status: "completed", metadata: { sessionId: "child" } },
    };
    const nested = {
      type: "tool",
      tool: "task",
      state: { status: "running", metadata: { sessionId: "grandchild" } },
    };
    const resumed = { ...first, state: { ...first.state, status: "running" } };
    const grandchild = { id: "grandchild-message", role: "assistant", sessionID: "grandchild" };
    const sessions = projectArenaSessions({
      sessionID: "root",
      messages: [
        { id: "parent", sessionID: "root" },
        { id: "child-message", sessionID: "child" },
        grandchild,
        { id: "resumed", sessionID: "root" },
      ],
      parts: { parent: [first], "child-message": [nested], resumed: [resumed] },
    });
    expect(sessions.byTask.size).toBe(2);
    expect(sessions.byTask.get(first)?.task).toBe(resumed);
    expect(sessions.byTask.get(nested)?.messages).toEqual([grandchild]);
    expect(sessions.unattached).toEqual([]);
  });
});

describe("arenaSubagentRunState", () => {
  it("stops stale child activity when its delegation finishes", () => {
    expect(arenaSubagentRunState("pending", { state: { status: "completed" } })).toBe("complete");
    expect(arenaSubagentRunState("pending", { state: { status: "running" } })).toBe("pending");
    expect(arenaSubagentRunState("stopped", { state: { status: "running" } })).toBe("stopped");
  });

  it("reports a delegation cut short by Stop as stopped rather than failed", () => {
    const aborted = {
      state: {
        status: "error",
        error: "Tool execution aborted",
        metadata: { sessionId: "child", interrupted: true },
      },
    };
    expect(arenaSubagentRunState("stopped", aborted)).toBe("stopped");
    expect(arenaSubagentRunState("pending", aborted)).toBe("interrupted");
    expect(arenaSubagentRunState("interrupted", aborted)).toBe("interrupted");
  });

  it("keeps a delegation that failed on its own as failed", () => {
    const failed = { state: { status: "error", error: "Model unavailable", metadata: {} } };
    expect(arenaSubagentRunState("stopped", failed)).toBe("error");
    expect(arenaSubagentRunState("pending", failed)).toBe("error");
  });
});
