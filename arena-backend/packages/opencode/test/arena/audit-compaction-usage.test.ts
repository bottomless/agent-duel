import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir as osTmpdir } from "node:os"

describe("audit-compaction-usage", () => {
  test("treats a legacy zero as unknown when raw SSE has no reasoning field", async () => {
    const directory = await mkdtemp(path.join(osTmpdir(), "opencode-audit-"))
    try {
      const inputPath = path.join(directory, "generations.json")
      await Bun.write(
        inputPath,
        JSON.stringify([
          {
            _id: "generation-legacy-zero",
            runID: "run-1",
            rootSessionID: "root-1",
            sessionID: "root-1",
            classification: "root",
            requestKind: "generation",
            engagementID: "engagement-1",
            usage: { reasoningTokens: 0, completionTokens: 10, totalTokens: 10, cost: 0 },
            rawProviderResponse: [
              'data: {"type":"message_start","usage":{"input_tokens":5}}',
              "",
              'data: {"type":"message_delta","usage":{"output_tokens":10}}',
              "",
              "data: [DONE]",
            ].join("\n"),
          },
          {
            _id: "excluded-compaction",
            runID: "run-1",
            rootSessionID: "root-1",
            sessionID: "root-1",
            classification: "compaction",
            requestKind: "compaction",
            usage: { reasoningTokens: 1, completionTokens: 2, totalTokens: 3, cost: 0 },
          },
          {
            _id: "excluded-subagent",
            runID: "run-1",
            rootSessionID: "root-1",
            sessionID: "child-1",
            classification: "subagent",
            requestKind: "generation",
            usage: { reasoningTokens: 1, completionTokens: 2, totalTokens: 3, cost: 0 },
          },
        ]),
      )
      const script = path.resolve(import.meta.dir, "../../script/audit-compaction-usage.ts")
      const packageDirectory = path.resolve(import.meta.dir, "../..")
      const process = Bun.spawn(["bun", "run", script, inputPath], {
        cwd: packageDirectory,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [output, error, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(exitCode, error).toBe(0)
      const report = JSON.parse(output) as {
        totalRecords: number
        knownUsage: number
        unknownUsage: number
        countedCalls: number
        excludedRecords: number
        suspectZeroIDs: string[]
        calls: Array<Record<string, unknown>>
        skipRate?: number
      }
      expect(report.knownUsage).toBe(0)
      expect(report.unknownUsage).toBe(1)
      expect(report.totalRecords).toBe(3)
      expect(report.countedCalls).toBe(1)
      expect(report.excludedRecords).toBe(2)
      expect(report.suspectZeroIDs).toEqual(["generation-legacy-zero"])
      expect(report.skipRate).toBeUndefined()
      expect(report.calls[0]).not.toHaveProperty("decision")
      expect(report.calls[0]?.engagementID).toBe("engagement-1")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
