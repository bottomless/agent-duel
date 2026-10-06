import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import { create } from "@/arena/telemetry"
import { Store } from "@/arena/mongo"
import type { GenerationDocument, GenerationRetry } from "@/arena/records"
import type { RequestMetadata } from "@/arena/proxy"

function store(value: object): Store {
  return Object.assign(Object.create(Store.prototype), value)
}

describe("ArenaTelemetry", () => {
  test("stores generation artifacts without model-fingerprinting metadata", async () => {
    let generation: GenerationDocument | undefined
    let runUsage: GenerationDocument["usage"]
    const artifacts: Array<{ id: string; data: string }> = []
    const arena = store({
      storeArtifact: async (input: { _id: string; data: Uint8Array }) => {
        artifacts.push({ id: input._id, data: new TextDecoder().decode(input.data) })
        return input
      },
      saveGeneration: async (input: GenerationDocument) => {
        generation = input
        return input
      },
      updateGeneration: async (_id: string, patch: Partial<GenerationDocument>) => {
        generation = { ...generation!, ...patch }
        return generation
      },
      generationsForRuns: async () => (generation ? [generation] : []),
      updateRun: async (_id: string, patch: { usage?: GenerationDocument["usage"] }) => {
        runUsage = patch.usage
        return patch
      },
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const metadata: RequestMetadata = {
      assignment: {
        runID: "run-a",
        rootSessionID: "session-a",
        scopeID: "turn-a",
        assignmentID: "assignment-a",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000001",
      requestID: "00000000-0000-4000-8000-000000000001",
      sessionID: "session-a",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(Date.now() - 10),
    }

    await telemetry.start?.(metadata, {
      model: "contestant",
      messages: [
        {
          role: "assistant",
          content: "earlier",
          reasoning_details: [{ summary: "thinking", format: "xai-responses-v1" }],
        },
      ],
    })
    await telemetry.response?.({ metadata, status: 200, headers: {}, receivedAt: new Date() })
    telemetry.rawChunk?.(
      metadata,
      'data: {"id":"opaque-generation","model":"provider/hidden","provider":"hidden","choices":[{"finish_reason":"stop","native_finish_reason":"end_turn","delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"thinking","format":"anthropic-claude-v1","index":0}],"tool_calls":[{"id":"call-7529b035-5fd4-43dc-a17a-59c78f463f27-0","call_id":"call_0123456789abcdef01234567","function":{"arguments":"{\\"model\\":\\"domain-value\\"}"}}]}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"reasoning_tokens":1,"total_tokens":5}}\n',
    )
    await telemetry.complete?.(metadata, new Date())

    expect(artifacts.map((item) => item.id)).toEqual([`${metadata.generationID}|response`])
    expect(generation).toMatchObject({
      classification: "root",
      requestID: metadata.requestID,
      assignmentID: "assignment-a",
      requestedModel: "contestant",
      providerGenerationID: "opaque-generation",
      routing: {
        status: 200,
        headers: {},
      },
    })
    expect(generation).not.toHaveProperty("finishReason")
    expect(generation).not.toHaveProperty("usage")
    expect(generation).not.toHaveProperty("requestArtifactID")
    expect(generation?.payloadHashes).not.toHaveProperty("request")
    expect(artifacts[0]?.data).toContain("domain-value")
    expect(artifacts[0]?.data).not.toContain("hidden")
    expect(artifacts[0]?.data).not.toContain("native_finish_reason")
    expect(artifacts[0]?.data).not.toContain("anthropic-claude-v1")
    expect(artifacts[0]?.data).not.toContain("prompt_tokens")
    expect(artifacts[0]?.data).not.toContain("call-7529b035-5fd4-43dc-a17a-59c78f463f27-0")
    expect(artifacts[0]?.data).not.toContain("call_0123456789abcdef01234567")
    expect(artifacts[0]?.data).toContain("call_arena_")
    expect(generation?.firstTokenAt).toBeInstanceOf(Date)

    await telemetry.reveal?.({
      runIDs: ["run-a"],
      metrics: [
        {
          generationID: metadata.generationID,
          usage: {
            promptTokens: 2,
            completionTokens: 3,
            reasoningTokens: 1,
            totalTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.123,
            attempts: 1,
            latencyMs: 10,
          },
          finishReason: "stop",
        },
      ],
    })
    expect(generation).toMatchObject({ usage: { cost: 0.123, totalTokens: 5 }, finishReason: "stop" })
    expect(runUsage).toMatchObject({ cost: 0.123, totalTokens: 5 })
  })

  test("restores server-held metrics after an engine restart", async () => {
    const generationID = "gen_00000000000000000000000000000009"
    let generation = {
      _id: generationID,
      runID: "run-restarted",
      startedAt: new Date(),
    } as GenerationDocument
    let runUsage: GenerationDocument["usage"]
    const arena = store({
      generationsForRuns: async () => [generation],
      updateGeneration: async (_id: string, patch: Partial<GenerationDocument>) => {
        generation = { ...generation, ...patch }
        return generation
      },
      updateRun: async (_id: string, patch: { usage?: GenerationDocument["usage"] }) => {
        runUsage = patch.usage
        return patch
      },
    })

    await create(arena).reveal?.({
      runIDs: ["run-restarted"],
      metrics: [
        {
          generationID,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            reasoningTokens: 5,
            totalTokens: 120,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
            cost: 0.25,
            attempts: 1,
            latencyMs: 500,
          },
          finishReason: "stop",
        },
      ],
    })

    expect(generation).toMatchObject({ usage: { cost: 0.25, totalTokens: 120 }, finishReason: "stop" })
    expect(runUsage).toMatchObject({ cost: 0.25, totalTokens: 120 })
  })

  test("persists partial upstream output when a generation is interrupted", async () => {
    let generation: GenerationDocument | undefined
    const artifacts: Array<{ id: string; data: string }> = []
    const arena = store({
      storeArtifact: async (input: { _id: string; data: Uint8Array }) => {
        artifacts.push({ id: input._id, data: new TextDecoder().decode(input.data) })
        return input
      },
      saveGeneration: async (input: GenerationDocument) => {
        generation = input
        return input
      },
      updateGeneration: async (_id: string, patch: Partial<GenerationDocument>) => {
        generation = { ...generation!, ...patch }
        return generation
      },
      accumulateRunUsage: async () => undefined,
      addResolvedProvider: async () => undefined,
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const metadata: RequestMetadata = {
      assignment: {
        runID: "run-b",
        rootSessionID: "session-b",
        scopeID: "turn-b",
        assignmentID: "assignment-b",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000002",
      requestID: "00000000-0000-4000-8000-000000000002",
      sessionID: "session-b",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      classification: "compaction",
      startedAt: new Date(Date.now() - 10),
    }
    const partial = 'data: {"id":"partial-id","choices":[{"delta":{"content":"partial"}}]}\n'

    await telemetry.start?.(metadata, { model: "contestant", messages: [] })
    await telemetry.response?.({ metadata, status: 200, headers: {}, receivedAt: new Date() })
    telemetry.rawChunk?.(metadata, partial)
    await telemetry.error?.(metadata, new Error("stopped by user"), new Date())

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toEqual({ id: `${metadata.generationID}|response`, data: partial })
    expect(generation).toMatchObject({
      classification: "compaction",
      providerGenerationID: "partial-id",
      error: "Arena contestant request failed",
      responseArtifactID: `${metadata.generationID}|response`,
      payloadHashes: {
        response: createHash("sha256").update(partial).digest("hex"),
      },
    })
    expect(generation?.completedAt).toBeInstanceOf(Date)
    expect(generation?.firstTokenAt).toBeInstanceOf(Date)
  })

  test("links repeated proxy attempts and records a typed run retry history", async () => {
    const generations: GenerationDocument[] = []
    const retries: GenerationRetry[] = []
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => {
        generations.push(input)
        return input
      },
      recordGenerationRetry: async (_runID: string, retry: GenerationRetry) => {
        retries.push(retry)
      },
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const first: RequestMetadata = {
      assignment: {
        runID: "run-retry",
        rootSessionID: "session-retry",
        scopeID: "turn-retry",
        assignmentID: "assignment-retry",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000003",
      requestID: "00000000-0000-4000-8000-000000000003",
      sessionID: "session-retry",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date("2026-08-05T12:00:00.000Z"),
    }
    const second = {
      ...first,
      generationID: "gen_00000000000000000000000000000004",
      startedAt: new Date("2026-08-05T12:00:01.000Z"),
    }

    await telemetry.start?.(first, { model: "contestant", messages: [] })
    await telemetry.start?.(second, { model: "contestant", messages: [] })

    expect(generations).toHaveLength(2)
    expect(generations[0]).toMatchObject({
      requestID: first.requestID,
      callIndex: 0,
    })
    expect(generations[0]).not.toHaveProperty("retryParentID")
    expect(generations[1]).toMatchObject({
      requestID: first.requestID,
      retryParentID: generations[0]._id,
      callIndex: 1,
    })
    expect(retries).toEqual([
      {
        requestID: first.requestID,
        generationID: generations[1]._id,
        retryParentID: generations[0]._id,
        attemptIndex: 1,
        observedAt: second.startedAt,
      },
    ])
  })
})
