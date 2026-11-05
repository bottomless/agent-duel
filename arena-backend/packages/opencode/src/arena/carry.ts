import type { BattleAssignmentDecision } from "@agent-duel/arena-service/assignment-decision"
import { backend } from "./runtime"

export type CarryOutcome =
  | { readonly source: "replay"; readonly note: string }
  | { readonly source: "none"; readonly reason: string }

/**
 * Asks the service for the previous battle's handoff (`arena-service/src/carry.ts`). One request,
 * never retried: the service pays for a model call behind it and records the outcome under the
 * scope, so a second request would only read that record. A control plane or daemon that does not
 * know the route answers like a cold replay: no note, for both sides alike.
 */
export async function requestCarry(
  input: {
    readonly scopeID: string
    readonly decision: BattleAssignmentDecision
    readonly generationID: string
  },
  signal?: AbortSignal,
): Promise<CarryOutcome> {
  const target = backend()
  if (!target) return { source: "none", reason: "no-backend" }
  let response: Response
  try {
    response = await target.fetch(`${target.url}/api/arena/carry`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "carry", kind: "battle", ...input }),
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { source: "none", reason: "request-failed" }
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return { source: "none", reason: `status-${response.status}` }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { source: "none", reason: "invalid-answer" }
  }
  if (!response.ok) return { source: "none", reason: `status-${response.status}` }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { source: "none", reason: "invalid-answer" }
  }
  const answer = payload as Record<string, unknown>
  if (answer.version !== 1) return { source: "none", reason: "invalid-answer" }
  if (answer.source === "replay" && typeof answer.note === "string" && answer.note.trim()) {
    return { source: "replay", note: answer.note }
  }
  return { source: "none", reason: typeof answer.reason === "string" ? answer.reason : "invalid-answer" }
}
