export * as SessionCompactionRequest from "./compaction-request.js"

import { AIError, isContextOverflowFailure } from "@opencode/ai/effect"

/**
 * Agent Duel vendor patch: how to compact after a context-overflow failure. A provider policy can refuse a request
 * that still fits the window, only to have it summarized first, by marking its context-overflow error body with
 * `"compaction": "requested"`. Such a request is summarized as it is and keeps its prompt cache; any other overflow is
 * cut down as text. Arena's engine plugin sets the mark (`opencode/src/arena/engine-runtime/request.ts`).
 */
export const overflowReason = (failure: unknown): "overflow" | "requested" => {
  if (!(failure instanceof AIError) || !isContextOverflowFailure(failure) || failure.reason._tag !== "InvalidRequest")
    return "overflow"
  const body = failure.reason.body
  if (!body) return "overflow"
  try {
    const error = (JSON.parse(body) as { error?: { compaction?: unknown } } | null)?.error
    return error?.compaction === "requested" ? "requested" : "overflow"
  } catch {
    return "overflow"
  }
}
