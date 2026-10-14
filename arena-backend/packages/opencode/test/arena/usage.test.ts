import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import type { RunDocument, UsageTotals } from "@/arena/records"

function usage(upstreamInferenceCost?: number): UsageTotals {
  return {
    promptTokens: 1,
    completionTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    ...(upstreamInferenceCost === undefined ? {} : { upstreamInferenceCost }),
    attempts: 1,
    latencyMs: 1,
  }
}

describe("Arena run usage", () => {
  test("preserves known upstream costs atomically and keeps mixed totals unknown", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-run-usage-"))
    try {
      const [left, right] = await Promise.all([connectLocalStore({ directory }), connectLocalStore({ directory })])
      try {
        await left.runs.insertOne({ _id: "run", turnID: "turn" } as RunDocument)
        await left.accumulateRunUsage("run", usage(0.2))

        await Promise.all([left.accumulateRunUsage("run", usage(0.3)), right.accumulateRunUsage("run", usage(0.4))])
        expect((await left.runs.findOne({ _id: "run" }))?.usage?.upstreamInferenceCost).toBeCloseTo(0.9)

        await left.accumulateRunUsage("run", usage())
        expect((await left.runs.findOne({ _id: "run" }))?.usage?.upstreamInferenceCost).toBeUndefined()

        await left.accumulateRunUsage("run", usage(0.5))
        expect((await left.runs.findOne({ _id: "run" }))?.usage?.upstreamInferenceCost).toBeUndefined()
      } finally {
        await Promise.all([left.close(), right.close()])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
