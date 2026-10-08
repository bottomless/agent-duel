import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

function messageField(message: unknown, key: string): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const value = (message as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export function arenaThreadMessages(run: ArenaRun): unknown[] {
  const messages = run.messages ?? [];

  // A contestant session is a fork of the shared conversation, so from the moment it exists it
  // already holds every earlier turn and nothing of this one. The run becomes visible then —
  // the fork happens before the worktrees are ready and well before the prompt is dispatched —
  // and the fallback below would spend that gap showing the newest user message and everything
  // after it: the previous turn's winning reply, presented as this turn's work, until the real
  // boundary lands and it all vanishes. A run that has not started has nothing to show.
  if (!run.startedAt) return [];

  let promptIndex = -1;

  if (run.promptMessageID) {
    promptIndex = messages.findIndex(
      (message) => messageField(message, "id") === run.promptMessageID,
    );
  } else {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const sessionID = messageField(messages[index], "sessionID");
      const isRoot = !sessionID || sessionID === run.sessionID;
      if (isRoot && messageField(messages[index], "role") === "user") {
        promptIndex = index;
        break;
      }
    }
  }

  if (promptIndex < 0) return [];
  return messages.slice(promptIndex + 1).filter((message) => {
    const role = messageField(message, "role");
    return role === "user" || role === "assistant";
  });
}

export function arenaReasoningPartIsActive(
  run: Pick<ArenaRun, "runState">,
  part: unknown,
): boolean {
  if (run.runState !== "pending") return false;
  if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
  const record = part as Record<string, unknown>;
  if (record.type !== "reasoning" && record.type !== "thought") return false;
  const time = record.time;
  if (typeof time !== "object" || time === null || Array.isArray(time)) return true;
  return typeof (time as Record<string, unknown>).end !== "number";
}
