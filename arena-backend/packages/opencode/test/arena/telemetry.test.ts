import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import { carriesModelOutput, create } from "@/arena/telemetry"
import { Store } from "@/arena/mongo"
import type { GenerationDocument, GenerationRetry } from "@/arena/records"
import { ArenaWaitError, type RequestMetadata } from "@/arena/proxy"
import { begin, read, reset } from "@/arena/engagement-usage"
import { STEERING_COMPACTION_FIELD } from "@agent-duel/arena-service/request-budget"

function store(value: object): Store {
  return Object.assign(Object.create(Store.prototype), value)
}

describe("ArenaTelemetry", () => {
  test.each(["complete", "error"] as const)(
    "carries only the final steering decision through %s telemetry",
    async (outcome) => {
      const artifacts: string[] = []
      const arena = store({
        generationsForRuns: async () => [],
        saveGeneration: async (input: GenerationDocument) => input,
        updateGeneration: async (_id: string, patch: Partial<GenerationDocument>) => patch,
        storeArtifact: async (input: { data: Uint8Array }) => {
          artifacts.push(new TextDecoder().decode(input.data))
          return input
        },
        recordGenerationRetry: async () => undefined,
      })
      const telemetry = create(arena)
      const engagement = begin({ runID: "decision-run", sessionID: "decision-root" })
      try {
        const decisions = [true, false, null, undefined, "true"]
        for (const [index, decision] of decisions.entries()) {
          const metadata: RequestMetadata = {
            assignment: {
              runID: "decision-run",
              rootSessionID: "decision-root",
              scopeID: "turn",
              assignmentID: "assignment",
              telemetry: true,
            },
            generationID: `decision-${outcome}-${index}`,
            requestID: `request-${index}`,
            sessionID: "decision-root",
            requestedModel: "contestant",
            enforcedReasoning: { effort: "high" },
            requestKind: "generation",
            startedAt: new Date(0),
          }
          await telemetry.start?.(metadata, { model: "contestant", messages: [] })
          const payload = {
            usage: { prompt_tokens: 54_000, completion_tokens: 400 },
            [STEERING_COMPACTION_FIELD]: decision,
          }
          // A later unknown decision must clear an earlier true within the same stream.
          const raw =
            index === 2
              ? `data: ${JSON.stringify({ ...payload, [STEERING_COMPACTION_FIELD]: true })}\n\ndata: ${JSON.stringify(payload)}\n\n`
              : JSON.stringify(payload)
          // HTTP chunks need not align with either JSON or SSE frames.
          telemetry.rawChunk?.(metadata, raw.slice(0, 17))
          telemetry.rawChunk?.(metadata, raw.slice(17))
          if (outcome === "complete") await telemetry.complete?.(metadata, new Date(index + 1))
          else await telemetry.error?.(metadata, new Error("stream ended"), new Date(index + 1))
          expect(read(engagement)?.useCompactionForSteer).toBe(typeof decision === "boolean" ? decision : undefined)
        }
        expect(artifacts.every((artifact) => !artifact.includes(STEERING_COMPACTION_FIELD))).toBe(true)
      } finally {
        reset()
      }
    },
  )

  test("persists a completed call with no usage as unknown, then accepts a late known reveal", async () => {
    let generation: GenerationDocument | undefined
    let runUsage: GenerationDocument["usage"]
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
      updateRun: async (_id: string, patch: { usage?: GenerationDocument["usage"] }) => {
        runUsage = patch.usage
        return patch
      },
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
      run: async () => ({ _id: "run", turnID: "turn" }),
      turn: async () => ({ _id: "turn", resolution: { kind: "vote", vote: "a", appliedSide: "a" } }),
    })
    const telemetry = create(arena)
    const metadata: RequestMetadata = {
      assignment: {
        runID: "run",
        rootSessionID: "root",
        scopeID: "turn",
        assignmentID: "assignment",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000041",
      requestID: "00000000-0000-4000-8000-000000000041",
      sessionID: "root",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      requestKind: "generation",
      startedAt: new Date(Date.now() - 10),
    }
    await telemetry.start?.(metadata, { model: "contestant", messages: [] })
    await telemetry.complete?.(metadata, new Date())
    await telemetry.reveal?.({ runIDs: ["run"], metrics: [] })
    expect(generation?.usage).toMatchObject({ promptTokens: null, completionTokens: null, reasoningTokens: null })
    expect(runUsage).toMatchObject({ promptTokens: null, completionTokens: null, cost: null })
    await telemetry.reveal?.({
      runIDs: ["run"],
      metrics: [
        {
          generationID: metadata.generationID,
          usage: {
            promptTokens: 10,
            completionTokens: 3,
            reasoningTokens: 1,
            totalTokens: 13,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            attempts: 1,
            latencyMs: 10,
          },
        },
      ],
    })
    expect(generation?.usage).toMatchObject({ promptTokens: 10, completionTokens: 3, cost: 0 })
  })

  test("refreshes late revealed compaction metrics without delaying completion", async () => {
    const generations = new Map<string, GenerationDocument>()
    let resolverCalls = 0
    const lateID = "gen_00000000000000000000000000000031"
    const oldID = "gen_00000000000000000000000000000032"
    const usage = (cost: number | null) => ({
      promptTokens: 10,
      completionTokens: 4,
      reasoningTokens: 1,
      totalTokens: 14,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost,
      attempts: 1,
      latencyMs: 1,
      provenance: "provider" as const,
      version: 2 as const,
    })
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
      updateRun: async () => undefined,
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
      run: async () => ({ _id: "run", turnID: "turn" }),
      turn: async () => ({
        _id: "turn",
        resolution: { kind: "vote", vote: "a", appliedSide: "a" },
      }),
    })
    const telemetry = create(arena, {
      resolveAssignments: async (_kind, _scopeID, decision) => {
        resolverCalls += 1
        expect(decision).toBe("select:a")
        return {
          decision,
          assignments: [
            {
              assignmentID: "assignment-a",
              model: "model-a",
              metrics: [
                { generationID: oldID, usage: usage(0.1) },
                ...(resolverCalls > 1 ? [{ generationID: lateID, usage: usage(0.42) }] : []),
              ],
            },
          ],
        }
      },
    })
    const metadata = (generationID: string, requestKind: "generation" | "compaction", classification?: "compaction") =>
      ({
        assignment: {
          runID: "run",
          rootSessionID: "root",
          scopeID: "turn",
          assignmentID: "assignment-a",
          telemetry: true,
        },
        generationID,
        requestID: generationID,
        sessionID: "root",
        requestedModel: "contestant",
        enforcedReasoning: { effort: "high" as const },
        requestKind,
        ...(classification ? { classification } : {}),
        ...(classification ? { opportunisticCompactionID: "compact-1" } : {}),
        startedAt: new Date(Date.now() - 10),
      }) satisfies RequestMetadata
    const old = metadata(oldID, "generation")
    const late = metadata(lateID, "compaction", "compaction")
    const answer = async (input: RequestMetadata) => {
      await telemetry.start?.(input, { model: "contestant", messages: [] })
      telemetry.rawChunk?.(
        input,
        `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n`,
      )
      await telemetry.complete?.(input, new Date())
    }
    await answer(old)
    await answer(late)
    expect(resolverCalls).toBe(0)
    await telemetry.reveal?.({ runIDs: ["run"], metrics: [{ generationID: oldID, usage: usage(0.1) }] })
    for (let attempt = 0; attempt < 20 && resolverCalls < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(resolverCalls).toBe(2)
    expect(generations.get(lateID)?.usage?.cost).toBe(0.42)
  })

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

  test("keeps a refused attempt's error body out of the first token, and user-side waits out of the retries", async () => {
    const generations: GenerationDocument[] = []
    const updates = new Map<string, Record<string, unknown>>()
    const retries: GenerationRetry[] = []
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => {
        generations.push(input)
        return input
      },
      updateGeneration: async (id: string, update: Record<string, unknown>) => {
        updates.set(id, { ...updates.get(id), ...update })
      },
      generationsForRuns: async () => generations,
      recordGenerationRetry: async (_runID: string, retry: GenerationRetry) => {
        retries.push(retry)
      },
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const attempt = (index: number): RequestMetadata => ({
      assignment: {
        runID: "run-refused",
        rootSessionID: "session-refused",
        scopeID: "turn-refused",
        assignmentID: "assignment-refused",
        telemetry: true,
      },
      generationID: `gen_0000000000000000000000000000001${index}`,
      requestID: "00000000-0000-4000-8000-000000000010",
      sessionID: "session-refused",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      requestKind: "generation",
      startedAt: new Date(Date.UTC(2026, 9, 30, 12, 0, index)),
    })
    const refuse = async (metadata: RequestMetadata, status: number, error: unknown) => {
      await telemetry.start?.(metadata, { model: "contestant", messages: [] })
      await telemetry.response?.({ metadata, status, headers: {}, receivedAt: new Date() })
      telemetry.rawChunk?.(metadata, '{"error":{"message":"Arena contestant request failed"}}')
      await telemetry.error?.(metadata, error, new Date())
    }

    // Offline, signed out, a provider error, then a success: one retry, not three.
    await refuse(attempt(0), 503, new ArenaWaitError("network"))
    await refuse(attempt(1), 401, new ArenaWaitError("sign-in"))
    await refuse(attempt(2), 500, new Error("Arena upstream status 500"))
    await telemetry.start?.(attempt(3), { model: "contestant", messages: [] })

    expect(updates.get(attempt(0).generationID)).toMatchObject({ wait: "network" })
    expect(updates.get(attempt(1).generationID)).toMatchObject({ wait: "sign-in" })
    expect(updates.get(attempt(2).generationID)).not.toHaveProperty("wait")
    for (const index of [0, 1, 2]) {
      expect(updates.get(attempt(index).generationID)).toMatchObject({ error: "Arena contestant request failed" })
      expect(updates.get(attempt(index).generationID)).not.toHaveProperty("firstTokenAt")
    }
    expect(generations.map((generation) => generation.retryParentID)).toEqual([
      undefined,
      attempt(0).generationID,
      attempt(1).generationID,
      attempt(2).generationID,
    ])
    expect(generations.every((generation) => generation.requestKind === "generation")).toBe(true)
    // The waits are not attempts: the provider error is attempt 0 and its retry attempt 1.
    expect(retries.map((retry) => [retry.generationID, retry.attemptIndex])).toEqual([[attempt(3).generationID, 1]])
  })

  test("knows model output from the other lines of every stream shape", () => {
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\n`
    for (const chunk of [
      data({ choices: [{ index: 0, delta: { content: "Hi" } }] }),
      data({ choices: [{ index: 0, delta: { reasoning: "Thinking" } }] }),
      data({ choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text: "x" }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "read" } }] } }] }),
      data({ type: "response.output_text.delta", delta: "Hi" }),
      data({ type: "response.reasoning_summary_text.delta", delta: "x" }),
      data({ type: "response.function_call_arguments.delta", delta: '{"' }),
      data({ type: "response.output_item.added", item: { type: "function_call", name: "read" } }),
      JSON.stringify({ choices: [{ message: { content: "Hi" } }] }),
      JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }] }),
    ])
      expect(carriesModelOutput(chunk)).toBe(true)
    for (const chunk of [
      "\n",
      ": OPENROUTER PROCESSING\n",
      ": arena-heartbeat\n",
      "data: [DONE]\n",
      data({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1 } }),
      data({ type: "response.created", response: { id: "r" } }),
      data({ type: "response.output_item.added", item: { type: "message", content: [] } }),
      data({ error: { message: "Arena contestant request failed" } }),
    ])
      expect(carriesModelOutput(chunk)).toBe(false)
  })

  test("times the first token from the first chunk with model output", async () => {
    const updates = new Map<string, Record<string, unknown>>()
    const arena = store({
      storeArtifact: async (input: { _id: string }) => input,
      saveGeneration: async (input: GenerationDocument) => input,
      updateGeneration: async (id: string, update: Record<string, unknown>) => {
        updates.set(id, { ...updates.get(id), ...update })
      },
      generationsForRuns: async () => [],
      recordGenerationRetry: async () => undefined,
      addDescendant: async () => undefined,
    })
    const telemetry = create(arena)
    const metadata: RequestMetadata = {
      assignment: {
        runID: "run-first-token",
        rootSessionID: "session-first-token",
        scopeID: "turn-first-token",
        assignmentID: "assignment-first-token",
        telemetry: true,
      },
      generationID: "gen_00000000000000000000000000000020",
      requestID: "00000000-0000-4000-8000-000000000020",
      sessionID: "session-first-token",
      requestedModel: "contestant",
      enforcedReasoning: { effort: "high" },
      startedAt: new Date(),
    }
    await telemetry.start?.(metadata, { model: "contestant", messages: [] })
    await telemetry.response?.({ metadata, status: 200, headers: {}, receivedAt: new Date() })
    telemetry.rawChunk?.(metadata, "\n")
    telemetry.rawChunk?.(metadata, ": arena-heartbeat\n")
    telemetry.rawChunk?.(metadata, 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const beforeOutput = Date.now()
    telemetry.rawChunk?.(metadata, 'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n')
    await telemetry.complete?.(metadata, new Date())
    const firstTokenAt = updates.get(metadata.generationID)?.firstTokenAt
    expect(firstTokenAt).toBeInstanceOf(Date)
    expect((firstTokenAt as Date).getTime()).toBeGreaterThanOrEqual(beforeOutput)
  })

  test("continues a run's call numbering from its stored generations after an engine restart", async () => {
    const generations = [0, 1, 2].map(
      (callIndex) => ({ _id: `gen_stored_${callIndex}`, runID: "run-resumed", callIndex }) as GenerationDocument,
    )
    let reads = 0
    const arena = store({
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
