import type { SessionV1 } from "./session-shape"
import type { SessionStatusEvent } from "@opencode/schema/session-status-event"

export type Reason = "length" | "arena-idle"
export function reason(finish?: string): Reason | undefined {
  return finish === "length" || finish === "arena-idle" ? finish : undefined
}
export const IDLE_RECOVERING = "Continuing after model timeout"
export const IDLE_EXHAUSTED =
  "The model stopped responding after three recovery attempts. Completed work has been preserved. Continue with a smaller request."
export const IDLE_TOOL_INTERRUPTED =
  "The model stopped responding while generating this tool call. This call was not executed. Replace it with smaller writes or patches. Do not repeat successful tool calls."
export const IDLE_CONTINUE =
  "The previous response was cancelled because the model stopped sending output. Continue from the partial response without repeating it. Any unfinished tool call was not executed. Do not repeat the oversized write: use writes or patches of at most 100 lines per call, then continue in further steps. Preserve completed work. Do not repeat successful tool calls. Keep reasoning concise."

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

// Read durable history so restarts cannot grant more attempts. A successful response ends
// the recovery sequence; compaction summaries and failed tools do not prove recovery.
export function count(messages: readonly SessionV1.WithParts[]) {
  let attempts = 0
  for (const message of messages.toReversed()) {
    const { info, parts } = message
    if (info.role === "user") {
      const replay = parts.some((part) => part.type === "text" && part.metadata?.arena_compaction_replay === true)
      const real = parts.some((part) => part.type !== "compaction" && !("synthetic" in part && part.synthetic))
      if (!replay && real) break
      continue
    }
    if (info.summary) continue
    if (reason(info.finish)) {
      attempts++
      continue
    }
    const complete = info.finish === "stop" || info.finish === "tool-calls"
    const failedTool = parts.some((part) => part.type === "tool" && part.state.status !== "completed")
    if (complete && !info.error && !failedTool) break
  }
  return attempts
}

export function status(attempt: number, cause: Reason): SessionStatusEvent.Info {
  return { type: "retry", attempt, message: cause === "arena-idle" ? IDLE_RECOVERING : RECOVERING, next: Date.now() }
}

export * as ArenaResponseRecovery from "./response-recovery"
