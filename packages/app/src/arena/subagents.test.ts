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
  it("settles a native background child while its parent and sibling keep working", () => {
    const task = {
      type: "tool",
      tool: "subagent",
      state: {
        status: "completed",
        input: { description: "QUICK", agent: "general", background: true },
        metadata: { sessionID: "quick", status: "running" },
      },
    };
    const quick = {
      id: "quick-answer",
      role: "assistant",
      sessionID: "quick",
      finish: "stop",
      time: { completed: 10 },
    };
    const long = { id: "long-answer", role: "assistant", sessionID: "long" };
    const parts = {
      parent: [task],
      "quick-answer": [
        { type: "reasoning", text: "Done", time: { start: 1, end: 2 } },
        { type: "text", text: "QUICK done" },
      ],
      "long-answer": [{ type: "tool", tool: "shell", state: { status: "running" } }],
    };
    const sessions = projectArenaSessions({
      sessionID: "root",
      messages: [{ id: "parent", sessionID: "root" }, quick, long],
      parts,
    });
    const child = sessions.byTask.get(task);
    expect(child).toEqual({ id: "quick", name: "QUICK", task, messages: [quick] });
    expect(
      arenaSubagentRunState("pending", child?.task, { messages: child?.messages, parts }),
    ).toBe("complete");
    expect(arenaSubagentRunState("pending", task, { messages: [long], parts })).toBe("pending");
    expect(
      arenaSubagentRunState("pending", task, {
        messages: [quick, { id: "follow-up", role: "user", sessionID: "quick" }],
        parts,
      }),
    ).toBe("pending");
  });

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
