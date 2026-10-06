import { describe, expect, it } from "vitest";
import { parseOpenCodeTodoList, parseOpenCodeTodoWriteState } from "./todo";

describe("OpenCode task snapshots", () => {
  it("keeps valid rows, repairs swaps, and preserves task names exactly", () => {
    const tasks = [
      { content: "  Keep spaces  ", status: "pending", priority: "high" },
      { content: "Recovered", status: "low", priority: "completed" },
      { content: "Bad", status: "done", priority: "medium" },
      { status: "pending", priority: "low" },
      { content: "", status: "cancelled", priority: "low" },
    ];
    const original = structuredClone(tasks);
    expect(parseOpenCodeTodoList(tasks)).toEqual([
      { content: "  Keep spaces  ", status: "pending", priority: "high" },
      { content: "Recovered", status: "completed", priority: "low" },
      { content: "", status: "cancelled", priority: "low" },
    ]);
    expect(tasks).toEqual(original);
  });

  it("uses saved output before raw input and honors an explicit empty list", () => {
    const input = { todos: [{ content: "Raw", status: "pending", priority: "high" }] };
    expect(
      parseOpenCodeTodoWriteState({
        input,
        output: JSON.stringify([{ content: "Saved", status: "completed", priority: "low" }]),
      }),
    ).toEqual([{ content: "Saved", status: "completed", priority: "low" }]);
    expect(parseOpenCodeTodoWriteState({ input, metadata: { todos: [] } })).toEqual([]);
    expect(parseOpenCodeTodoWriteState({ input, metadata: { todos: null } })).toBeNull();
  });
});
