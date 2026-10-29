import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import { create } from "@/arena/telemetry"
import { Store } from "@/arena/mongo"
import type { ArtifactDocument, GenerationDocument, GenerationRetry } from "@/arena/records"
import type { RequestMetadata } from "@/arena/proxy"
import { loadRequest } from "@/arena/request-manifest"

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

    const response = artifacts.find((item) => item.id === `${metadata.generationID}|response`)
    expect(response).toBeDefined()
    expect(artifacts.map((item) => item.id)).toContain(`${metadata.generationID}|manifest`)
    expect(artifacts.filter((item) => item.id.includes("|component|"))).toHaveLength(2)
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
    expect(response?.data).toContain("domain-value")
    expect(response?.data).not.toContain("hidden")
    expect(response?.data).not.toContain("native_finish_reason")
    expect(response?.data).not.toContain("anthropic-claude-v1")
    expect(response?.data).not.toContain("prompt_tokens")
    expect(response?.data).not.toContain("call-7529b035-5fd4-43dc-a17a-59c78f463f27-0")
    expect(response?.data).not.toContain("call_0123456789abcdef01234567")
    expect(response?.data).toContain("call_arena_")
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
            upstreamInferenceCost: 0.456,
            attempts: 1,
            latencyMs: 10,
          },
          finishReason: "stop",
        },
      ],
    })
    expect(generation).toMatchObject({
      usage: { cost: 0.123, upstreamInferenceCost: 0.456, totalTokens: 5 },
      finishReason: "stop",
    })
    expect(runUsage).toMatchObject({ cost: 0.123, upstreamInferenceCost: 0.456, totalTokens: 5 })
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
            upstreamInferenceCost: 0.5,
            attempts: 1,
            latencyMs: 500,
          },
          finishReason: "stop",
        },
      ],
    })

    expect(generation).toMatchObject({
      usage: { cost: 0.25, upstreamInferenceCost: 0.5, totalTokens: 120 },
      finishReason: "stop",
    })
    expect(runUsage).toMatchObject({ cost: 0.25, upstreamInferenceCost: 0.5, totalTokens: 120 })
  })

  test("keeps the response's cache counts when the service recorded no metrics", async () => {
    let generation: GenerationDocument | undefined
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => {
        generation = input
        return input
      },
      updateGeneration: async (_id: string, patch: Partial<GenerationDocument>) => {
        generation = { ...generation!, ...patch }
        return generation
      },
      generationsForRuns: async () => (generation ? [generation] : []),
      updateRun: async (_id: string, patch: object) => patch,
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
      generationID: "gen_00000000000000000000000000000002",
      requestID: "00000000-0000-4000-8000-000000000002",
      sessionID: "session-a",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(Date.now() - 10),
    }

    await telemetry.start?.(metadata, { model: "contestant", messages: [] })
    await telemetry.response?.({ metadata, status: 200, headers: {}, receivedAt: new Date() })
    telemetry.rawChunk?.(
      metadata,
      'data: {"choices":[{"finish_reason":"stop","delta":{"content":"done"}}],"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":900,"cache_write_tokens":80}}}\n',
    )
    await telemetry.complete?.(metadata, new Date())
    await telemetry.reveal?.({ runIDs: ["run-a"], metrics: [] })

    expect(generation?.usage).toMatchObject({ promptTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 80 })
  })

  test("lets go of a released run's usage, including a request that reports after the release", async () => {
    const generations = new Map<string, GenerationDocument>()
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => {
        generations.set(input._id, input)
        return input
      },
      updateGeneration: async (id: string, patch: Partial<GenerationDocument>) => {
        const next = { ...generations.get(id)!, ...patch }
        generations.set(id, next)
        return next
      },
      generationsForRuns: async () => [...generations.values()],
      updateRun: async (_id: string, patch: object) => patch,
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const request = (n: number): RequestMetadata => ({
      assignment: {
        runID: "run-a",
        rootSessionID: "session-a",
        scopeID: "turn-a",
        assignmentID: "assignment-a",
        telemetry: true,
      },
      generationID: `gen_0000000000000000000000000000001${n}`,
      requestID: `00000000-0000-4000-8000-00000000001${n}`,
      sessionID: "session-a",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(Date.now() - 10),
    })
    const answer = async (metadata: RequestMetadata) => {
      await telemetry.start?.(metadata, { model: "contestant", messages: [] })
      await telemetry.response?.({ metadata, status: 200, headers: {}, receivedAt: new Date() })
      telemetry.rawChunk?.(
        metadata,
        'data: {"choices":[{"finish_reason":"stop","delta":{"content":"done"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
      )
      await telemetry.complete?.(metadata, new Date())
    }

    await answer(request(1))
    await telemetry.release?.({ runIDs: ["run-a"] })
    await answer(request(2))
    // Nothing is held for a reveal any more, so even one would persist no usage.
    await telemetry.reveal?.({ runIDs: ["run-a"], metrics: [] })

    expect([...generations.values()].map((generation) => generation.usage)).toEqual([undefined, undefined])
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
      generationsForRuns: async () => [],
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

    expect(artifacts).toHaveLength(3)
    expect(artifacts[0]?.id).toMatch(/^run-b\|component\|[0-9a-f]{64}$/)
    expect(artifacts[1]?.id).toBe(`${metadata.generationID}|manifest`)
    expect(artifacts[2]).toEqual({ id: `${metadata.generationID}|response`, data: partial })
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
      generationsForRuns: async () => generations,
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

  test("stores the dispatched request blinded in its messages and exact everywhere else", async () => {
    const artifacts = new Map<string, ArtifactDocument>()
    const arena = store({
      storeArtifact: async (input: ArtifactDocument) => {
        const document = { ...input, data: Buffer.from(input.data), truncated: false }
        if (!artifacts.has(input._id)) artifacts.set(input._id, document)
        return document
      },
      artifact: async (id: string) => artifacts.get(id),
      saveGeneration: async (input: GenerationDocument) => input,
      generationsForRuns: async () => [],
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const metadata: RequestMetadata = {
      assignment: {
        runID: "run-request",
        rootSessionID: "session-request",
        scopeID: "turn-request",
        assignmentID: "assignment-request",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000005",
      requestID: "00000000-0000-4000-8000-000000000005",
      sessionID: "session-request",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(),
    }
    const tools = [
      {
        type: "function",
        function: {
          name: "configure",
          parameters: { type: "object", properties: { model: { type: "string" }, provider: { type: "string" } } },
        },
      },
    ]

    await telemetry.start?.(metadata, {
      model: "contestant",
      reasoning: { effort: "high" },
      tools,
      messages: [
        { role: "user", content: "use the configure tool" },
        {
          role: "assistant",
          content: "",
          reasoning_details: [{ type: "reasoning.encrypted", data: "sealed", format: "anthropic-claude-v1" }],
          tool_calls: [
            {
              id: "call-7529b035-5fd4-43dc-a17a-59c78f463f27-0",
              type: "function",
              function: { name: "configure", arguments: '{"model":"domain-value"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-7529b035-5fd4-43dc-a17a-59c78f463f27-0", content: "configured" },
      ],
    })

    const loaded = await loadRequest(arena, "run-request", metadata.generationID)
    expect(loaded?.verified).toBe(true)
    const serialized = JSON.stringify(loaded?.body)
    expect(serialized).not.toContain("call-7529b035-5fd4-43dc-a17a-59c78f463f27-0")
    expect(serialized).not.toContain("anthropic-claude-v1")
    expect(serialized).not.toContain("reasoning_details")
    expect(serialized).toContain("domain-value")
    expect(serialized).toContain("configured")
    expect(loaded?.body.tools).toEqual(tools)
    expect(loaded?.body.reasoning).toEqual({ effort: "high" })
    const [, assistant, tool] = loaded?.body.messages as Array<Record<string, unknown>>
    const callID = (assistant?.tool_calls as Array<{ id: string }>)[0]?.id
    expect(callID).toStartWith("call_arena_")
    expect(tool?.tool_call_id).toBe(callID)
  })

  test("continues a run's call numbering from its stored generations after an engine restart", async () => {
    const generations = [0, 1, 2].map(
      (callIndex) => ({ _id: `gen_stored_${callIndex}`, runID: "run-resumed", callIndex }) as GenerationDocument,
    )
    let reads = 0
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => {
        generations.push(input)
        return input
      },
      generationsForRuns: async (runIDs: readonly string[]) => {
        reads++
        return generations.filter((generation) => runIDs.includes(generation.runID))
      },
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const request = (generation: number, sessionID: string): RequestMetadata => ({
      assignment: {
        runID: "run-resumed",
        rootSessionID: "session-root",
        scopeID: "turn-resumed",
        assignmentID: "assignment-resumed",
        telemetry: true,
      },
      generationID: `gen_0000000000000000000000000000001${generation}`,
      requestID: `00000000-0000-4000-8000-00000000001${generation}`,
      sessionID,
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(),
    })

    // A resumed root and a subagent reach the proxy together, before either number is known.
    await Promise.all([
      telemetry.start?.(request(0, "session-root"), { model: "contestant", messages: [] }),
      telemetry.start?.(request(1, "session-child"), { model: "contestant", messages: [] }),
    ])
    await telemetry.start?.(request(2, "session-root"), { model: "contestant", messages: [] })

    expect(generations.map((generation) => generation.callIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(reads).toBe(1)
  })
})
