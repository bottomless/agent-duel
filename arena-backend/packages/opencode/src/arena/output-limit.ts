import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const MAX_RECOVERIES = 3
export const RECOVERING = "Continuing after response limit"
export const EXHAUSTED =
  "Response limit reached after three recovery attempts. Completed work has been preserved. Continue with a smaller request."
export const TOOL_INTERRUPTED =
  "Your tool arguments exceeded the response limit. This call was not executed. Split the operation into smaller writes or patches. Do not repeat tools that already completed."
export const CONTINUE =
  "The previous response reached its output limit. Continue from the partial response without repeating it. Any unfinished tool call was not executed: replace it with smaller, complete writes or patches. Preserve completed work and do not repeat successful tool calls. Keep reasoning concise and make progress in smaller steps."
export const INSTRUCTION =
  "Each response has a limited output budget, which may also include reasoning. Create large files incrementally with smaller writes or patches, and use targeted edits. Finish each tool call within one response."

// Count durable responses, including those before compaction, so restarting the loop cannot
// reset the recovery budget. Compaction's synthetic user messages do not start a new turn.
export function count(messages: readonly SessionV1.WithParts[]) {
  const user = messages.findLast(
    (m) =>
      m.info.role === "user" &&
      !m.parts.some((p) => p.type === "text" && p.metadata?.arena_compaction_replay === true) &&
      m.parts.some((p) => p.type !== "compaction" && !("synthetic" in p && p.synthetic)),
  )
  return messages.filter(
    (m) =>
      m.info.role === "assistant" &&
      !m.info.summary &&
      m.info.finish === "length" &&
      (!user || m.info.id > user.info.id),
  ).length
}

export function status(attempt: number): SessionStatusEvent.Info {
  return { type: "retry", attempt, message: RECOVERING, next: Date.now() }
}

export * as ArenaOutputLimit from "./output-limit"
