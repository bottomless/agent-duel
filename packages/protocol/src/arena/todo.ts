export type OpenCodeTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type OpenCodeTodoPriority = "high" | "medium" | "low";

export interface OpenCodeTodo {
  content: string;
  status: OpenCodeTodoStatus;
  priority: OpenCodeTodoPriority;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function status(value: unknown): value is OpenCodeTodoStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
  );
}

function priority(value: unknown): value is OpenCodeTodoPriority {
  return value === "high" || value === "medium" || value === "low";
}

export function parseOpenCodeTodoList(value: unknown): OpenCodeTodo[] | null {
  if (typeof value === "string") {
    try {
      return parseOpenCodeTodoList(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const list = Array.isArray(value) ? value : record(value)?.todos;
  if (!Array.isArray(list)) return null;

  return list.flatMap((entry): OpenCodeTodo[] => {
    const task = record(entry);
    if (!task || typeof task.content !== "string") return [];
    if (status(task.status) && priority(task.priority)) {
      return [{ content: task.content, status: task.status, priority: task.priority }];
    }
    if (priority(task.status) && status(task.priority)) {
      return [{ content: task.content, status: task.priority, priority: task.status }];
    }
    return [];
  });
}

export function parseOpenCodeTodoWriteState(value: unknown): OpenCodeTodo[] | null {
  const state = record(value);
  if (!state) return null;
  const metadata = record(state.metadata);
  if (metadata && Object.hasOwn(metadata, "todos")) return parseOpenCodeTodoList(metadata.todos);
  if (state.output !== undefined) {
    const output = parseOpenCodeTodoList(state.output);
    if (output !== null) return output;
  }
  return parseOpenCodeTodoList(state.input);
}
