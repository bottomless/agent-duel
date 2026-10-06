import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { parseOpenCodeTodoWriteState, type OpenCodeTodo } from "@getpaseo/protocol/arena/todo";
import { arenaThreadMessages } from "./run-thread-selection";

export type ArenaTask = Pick<OpenCodeTodo, "content" | "status">;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function arenaTodoWriteTasks(part: unknown): ArenaTask[] | null {
  const record = asRecord(part);
  if (record?.type !== "tool" || record.tool !== "todowrite") return null;

  const state = asRecord(record.state);
  if (state?.status !== "completed") return null;

  const todos = parseOpenCodeTodoWriteState(state);
  if (todos === null) return null;

  return todos.map(({ content, status }) => ({ content, status }));
}

export function arenaRunTasks(run: ArenaRun): ArenaTask[] {
  const messages = arenaThreadMessages(run);
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const record = asRecord(messages[messageIndex]);
    if (record?.role !== "assistant") continue;
    if (typeof record.id !== "string") continue;

    const parts = run.parts?.[record.id] ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const snapshot = arenaTodoWriteTasks(parts[partIndex]);
      if (snapshot !== null) return snapshot;
    }
  }

  return [];
}
