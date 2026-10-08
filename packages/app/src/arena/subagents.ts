import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

export interface ArenaSessionThread {
  id: string;
  name: string;
  messages: unknown[];
  task: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function delegation(part: unknown) {
  const tool = record(part);
  if (tool?.type !== "tool" || tool.tool !== "task") return null;
  const state = record(tool.state);
  const sessionId = record(state?.metadata)?.sessionId;
  if (typeof sessionId !== "string") return null;
  const description = record(state?.input)?.description;
  const name = typeof description === "string" ? description.trim() : "";
  return { sessionId, name };
}

export function projectArenaSessions(run: Pick<ArenaRun, "sessionID" | "messages" | "parts">) {
  const root: ArenaSessionThread = {
    id: run.sessionID ?? "root",
    name: "",
    messages: [],
    task: null,
  };
  const sessions = new Map<string, ArenaSessionThread>([[root.id, root]]);
  const byTask = new Map<unknown, ArenaSessionThread>();
  function session(id: string): ArenaSessionThread {
    const existing = sessions.get(id);
    if (existing) return existing;
    const child: ArenaSessionThread = {
      id,
      name: `Task ${sessions.size}`,
      messages: [],
      task: null,
    };
    sessions.set(id, child);
    return child;
  }

  for (const message of run.messages ?? []) {
    const info = record(message);
    const id = typeof info?.sessionID === "string" ? info.sessionID : root.id;
    session(id).messages.push(message);
    if (typeof info?.id !== "string") continue;
    for (const part of run.parts?.[info.id] ?? []) {
      const task = delegation(part);
      if (!task || task.sessionId === root.id || task.sessionId === id) continue;
      const child = session(task.sessionId);
      // A resumed delegation keeps one transcript at its original position.
      if (child.task !== null) {
        child.task = part;
        continue;
      }
      if (task.name) child.name = task.name;
      child.task = part;
      byTask.set(part, child);
    }
  }
  const unattached = [...sessions.values()].filter((item) => item !== root && item.task === null);
  return { root, byTask, unattached };
}

export function arenaSubagentRunState(
  runState: ArenaRun["runState"],
  task: unknown,
): ArenaRun["runState"] {
  const state = record(record(task)?.state);
  if (state?.status === "completed") return "complete";
  if (state?.status === "error") {
    // Stop aborts the delegation, which OpenCode records as an error marked `interrupted`.
    if (record(state.metadata)?.interrupted !== true) return "error";
    return runState === "stopped" ? "stopped" : "interrupted";
  }
  return runState;
}
