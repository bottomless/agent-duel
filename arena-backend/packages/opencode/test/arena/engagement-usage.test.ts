import { afterEach, describe, expect, test } from "bun:test"
import { begin, bind, finalize, finish, read, reset } from "@/arena/engagement-usage"
import type { UsageTotals } from "@/arena/records"

const usage = (completionTokens: number | null, reasoningTokens: number | null): UsageTotals => ({
  promptTokens: 10,
  completionTokens,
  reasoningTokens,
  totalTokens: completionTokens === null ? null : 10 + completionTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  attempts: 1,
  latencyMs: 1,
  provenance: "provider",
  version: 2,
})

function call(generationID: string, usageValue: UsageTotals | undefined, rest: Record<string, unknown> = {}) {
  return {
    generationID,
    runID: "run",
    sessionID: "root",
    rootSessionID: "root",
    classification: "root" as const,
    requestKind: "generation" as const,
    finalizedAt: new Date(),
    ...(usageValue ? { usage: usageValue } : {}),
    ...rest,
  }
}

describe("engagement usage", () => {
  afterEach(reset)

  test("deduplicates finalized calls, filters non-root work, and keeps compactions", () => {
    const id = begin({ runID: "run", sessionID: "root" })
    bind("root-1", { runID: "run", sessionID: "root" })
    bind("subagent", { runID: "run", sessionID: "root" })
    bind("compact", { runID: "run", sessionID: "root" })
    finalize(call("root-1", usage(5, 2)))
    finalize(call("root-1", usage(5, 2)))
    finalize(call("subagent", usage(50, 50), { sessionID: "child", classification: "subagent" }))
    finalize(call("compact", usage(3, 1), { requestKind: "compaction", classification: "compaction" }))
    expect(read(id)).toMatchObject({
      rootCalls: 1,
      compactionCalls: 1,
      usage: { completionTokens: 5, reasoningTokens: 2 },
      compactionUsage: { completionTokens: 3, reasoningTokens: 1 },
    })
  })

  test("propagates unknown generated fields and retains late results after finish", () => {
    const id = begin({ runID: "run", sessionID: "root" })
    bind("root-1", { runID: "run", sessionID: "root" })
    finish(id)
    finalize(call("root-1", usage(null, null)))
    bind("root-2", { runID: "run", sessionID: "root" })
    finalize(call("root-2", undefined))
    expect(read(id)).toMatchObject({
      rootCalls: 2,
      usage: { completionTokens: null, reasoningTokens: null, cost: null },
    })
  })
})
