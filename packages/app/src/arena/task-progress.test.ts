import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaRunTasks, arenaTodoWriteTasks, type ArenaTask } from "./task-progress";

function run(
  messages: unknown[],
  parts: Record<string, unknown[]> = {},
  promptMessageID?: string,
  runState: ArenaRun["runState"] = "complete",
): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState,
    durationMs: 10,
    startedAt: "2026-09-11T10:00:00.000Z",
    selectable: true,
    applicable: true,
    messages,
    parts,
    ...(promptMessageID ? { promptMessageID } : {}),
  };
}

function todoWrite(
  todos: ArenaTask[],
  status: "completed" | "error" | "running" | "pending" = "completed",
) {
  return {
    type: "tool",
    tool: "todowrite",
    state: {
      status,
      input: {
        todos: todos.map((todo) => ({ ...todo, priority: "medium" })),
      },
    },
  };
}

function rawTodoWrite(todos: unknown) {
  return {
    type: "tool",
    tool: "todowrite",
    state: { status: "completed", input: { todos } },
  };
}

describe("arenaTodoWriteTasks", () => {
  it("uses the completed tool result instead of the raw input", () => {
    const part = rawTodoWrite([{ content: "Raw", status: "pending", priority: "medium" }]);
    const completed = {
      ...part,
      state: {
        ...part.state,
        metadata: { todos: [{ content: "Saved", status: "completed", priority: "low" }] },
      },
    };
    expect(arenaTodoWriteTasks(completed)).toEqual([{ content: "Saved", status: "completed" }]);
  });

  it("honors an empty result and does not fall back from an invalid result", () => {
    const part = todoWrite([{ content: "Raw", status: "pending" }]);
    expect(
      arenaTodoWriteTasks({ ...part, state: { ...part.state, metadata: { todos: [] } } }),
    ).toEqual([]);
    expect(
      arenaTodoWriteTasks({ ...part, state: { ...part.state, metadata: { todos: null } } }),
    ).toBeNull();
    expect(arenaTodoWriteTasks({ ...part, state: { ...part.state, metadata: {} } })).toEqual([
      { content: "Raw", status: "pending" },
    ]);
  });

  for (const priority of ["high", "medium", "low"]) {
    it.each(["pending", "in_progress", "completed", "cancelled"])(
      `recovers legacy swapped ${priority}/%s without mutating the transcript`,
      (status) => {
        const todos = [{ content: "Task", status: priority, priority: status }];
        const input = rawTodoWrite(todos);
        const result = { ...input, state: { ...input.state, metadata: { todos } } };
        const original = structuredClone(result);
        expect(arenaTodoWriteTasks(input)).toEqual([{ content: "Task", status }]);
        expect(arenaTodoWriteTasks(result)).toEqual([{ content: "Task", status }]);
        expect(result).toEqual(original);
      },
    );
  }

  it("skips a task with a status value in its priority field", () => {
    expect(
      arenaTodoWriteTasks(
        rawTodoWrite([{ content: "Task", status: "pending", priority: "completed" }]),
      ),
    ).toEqual([]);
  });

  it.each([
    { priority: "low" },
    { status: "broken", priority: "completed" },
    { status: "high", priority: "broken" },
    { status: "completed" },
    { status: "completed", priority: null },
  ])("skips other malformed rows: %j", (fields) => {
    expect(arenaTodoWriteTasks(rawTodoWrite([{ content: "Task", ...fields }]))).toEqual([]);
  });

  it.each([null, {}, "broken"])("rejects a malformed list: %j", (todos) => {
    expect(arenaTodoWriteTasks(rawTodoWrite(todos))).toBeNull();
  });

  it("keeps valid tasks when one task has an unknown status or no name", () => {
    expect(
      arenaTodoWriteTasks(
        rawTodoWrite([
          { content: "First", status: "completed", priority: "high" },
          { content: "Bad", status: "done", priority: "low" },
          { status: "pending", priority: "low" },
          { content: "  ", status: "cancelled", priority: "medium" },
        ]),
      ),
    ).toEqual([
      { content: "First", status: "completed" },
      { content: "  ", status: "cancelled" },
    ]);
  });

  it("projects a completed OpenCode todo write and ignores priority", () => {
    expect(
      arenaTodoWriteTasks(
        todoWrite([
          { content: "Inspect the battle", status: "completed" },
          { content: "Apply the fix", status: "in_progress" },
        ]),
      ),
    ).toEqual([
      { content: "Inspect the battle", status: "completed" },
      { content: "Apply the fix", status: "in_progress" },
    ]);
  });

  it("preserves cancelled status", () => {
    expect(
      arenaTodoWriteTasks(todoWrite([{ content: "Abandoned step", status: "cancelled" }])),
    ).toEqual([{ content: "Abandoned step", status: "cancelled" }]);
  });

  it("returns an explicit empty snapshot", () => {
    expect(arenaTodoWriteTasks(todoWrite([]))).toEqual([]);
  });
});

describe("arenaRunTasks", () => {
  it("updates all eight tasks through a swapped status and subsequent recovery", () => {
    const messages = [
      { id: "prompt", role: "user" },
      { id: "assistant", role: "assistant" },
    ];
    const before = Array.from({ length: 8 }, (_, index) => ({
      content: `Task ${index + 1}`,
      status: "pending" as const,
    }));
    const updated = before.map(({ content }, index) => ({
      content,
      status: index === 7 ? "high" : "completed",
      priority: index === 7 ? "in_progress" : "medium",
    }));
    const expected = before.map(({ content }, index) => ({
      content,
      status: index === 7 ? "in_progress" : "completed",
    }));
    const parts = { assistant: [todoWrite(before), rawTodoWrite(updated)] };
    expect(arenaRunTasks(run(messages, parts, "prompt", "pending"))).toEqual(expected);
    expect(arenaRunTasks(run(structuredClone(messages), structuredClone(parts), "prompt"))).toEqual(
      expected,
    );
    const recovered = before.map(({ content }) => ({ content, status: "completed" as const }));
    parts.assistant.push(todoWrite(recovered));
    expect(arenaRunTasks(run(messages, parts, "prompt"))).toEqual(recovered);
  });

  it("does not expose inherited tasks before the contestant starts", () => {
    const notStarted = run(
      [
        { id: "prompt", role: "user" },
        { id: "assistant", role: "assistant" },
      ],
      { assistant: [todoWrite([{ content: "Inherited", status: "completed" }])] },
      "prompt",
    );
    delete notStarted.startedAt;
    expect(arenaRunTasks(notStarted)).toEqual([]);
  });

  it("keeps task snapshots isolated between contestants", () => {
    const messages = [
      { id: "prompt", role: "user" },
      { id: "assistant", role: "assistant" },
    ];
    const tasksA: ArenaTask[] = [{ content: "A task", status: "in_progress" }];
    const tasksB: ArenaTask[] = [{ content: "B task", status: "completed" }];

    expect(arenaRunTasks(run(messages, { assistant: [todoWrite(tasksA)] }, "prompt"))).toEqual(
      tasksA,
    );
    expect(arenaRunTasks(run(messages, { assistant: [todoWrite(tasksB)] }, "prompt"))).toEqual(
      tasksB,
    );
  });

  it("starts at the battle prompt and excludes inherited history", () => {
    expect(
      arenaRunTasks(
        run(
          [
            { id: "old-assistant", role: "assistant" },
            { id: "prompt", role: "user" },
            { id: "new-assistant", role: "assistant" },
          ],
          {
            "old-assistant": [todoWrite([{ content: "Inherited", status: "completed" }])],
            "new-assistant": [todoWrite([{ content: "Current", status: "in_progress" }])],
          },
          "prompt",
        ),
      ),
    ).toEqual([{ content: "Current", status: "in_progress" }]);
  });

  it("uses the latest successful snapshot across steering replies", () => {
    expect(
      arenaRunTasks(
        run(
          [
            { id: "prompt", role: "user" },
            { id: "first", role: "assistant" },
            { id: "steering", role: "user" },
            { id: "second", role: "assistant" },
          ],
          {
            first: [todoWrite([{ content: "First plan", status: "in_progress" }])],
            second: [todoWrite([{ content: "Finished plan", status: "completed" }])],
          },
          "prompt",
        ),
      ),
    ).toEqual([{ content: "Finished plan", status: "completed" }]);
  });

  it("clears the previous snapshot when a later write has no tasks", () => {
    expect(
      arenaRunTasks(
        run(
          [
            { id: "prompt", role: "user" },
            { id: "assistant", role: "assistant" },
          ],
          {
            assistant: [todoWrite([{ content: "Done", status: "completed" }]), todoWrite([])],
          },
          "prompt",
        ),
      ),
    ).toEqual([]);
  });

  it("ignores malformed, failed, pending, and queued writes after a valid snapshot", () => {
    const malformed = {
      type: "tool",
      tool: "todowrite",
      state: {
        status: "completed",
        input: { todos: null },
      },
    };
    const messages = [
      { id: "prompt", role: "user" },
      { id: "assistant", role: "assistant" },
    ];
    const previous = [{ content: "Keep this", status: "in_progress" as const }];

    expect(
      arenaRunTasks(
        run(
          messages,
          {
            assistant: [
              todoWrite(previous),
              malformed,
              todoWrite([{ content: "Failed", status: "completed" }], "error"),
              todoWrite([{ content: "Pending", status: "completed" }], "pending"),
              todoWrite([{ content: "Queued", status: "completed" }], "running"),
            ],
          },
          "prompt",
        ),
      ),
    ).toEqual(previous);
  });

  it("returns no tasks when no prompt boundary is known", () => {
    expect(
      arenaRunTasks(
        run([{ id: "assistant", role: "assistant" }], {
          assistant: [todoWrite([{ content: "Unknown scope", status: "completed" }])],
        }),
      ),
    ).toEqual([]);
  });

  it("does not recover old tasks while the current battle prompt is missing from history", () => {
    expect(
      arenaRunTasks(
        run(
          [
            { id: "old-prompt", role: "user" },
            { id: "old-assistant", role: "assistant" },
          ],
          { "old-assistant": [todoWrite([{ content: "Previous battle", status: "pending" }])] },
          "current-prompt",
        ),
      ),
    ).toEqual([]);
  });

  it.each<ArenaRun["runState"]>(["complete", "stopped", "error", "interrupted"])(
    "preserves unfinished tasks when a run is %s and its transcript is reconstructed",
    (runState) => {
      const messages = [
        { id: "prompt", role: "user" },
        { id: "assistant", role: "assistant" },
      ];
      const tasks: ArenaTask[] = [
        { content: "Finished", status: "completed" },
        { content: "Still active in the last update", status: "in_progress" },
        { content: "Not attempted", status: "pending" },
        { content: "Abandoned", status: "cancelled" },
      ];
      const parts = { assistant: [todoWrite(tasks)] };
      const live = run(messages, parts, "prompt", "pending");
      const archived = run(structuredClone(messages), structuredClone(parts), "prompt", runState);

      expect(arenaRunTasks(live)).toEqual(tasks);
      expect(arenaRunTasks(archived)).toEqual(arenaRunTasks(live));
    },
  );
});
