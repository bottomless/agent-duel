import { createHash } from "crypto"
import type { Store } from "./mongo"
import { ArenaWaitError, type RequestMetadata, type Telemetry } from "./proxy"
import type { GenerationDocument, GenerationMetrics, UsageTotals } from "./records"
import { ArenaPrivacy } from "./privacy"
import { addUsageTotals, hasFinalProviderUsage, parseProviderUsage } from "@agent-duel/arena-service/usage"
import { requestTokenEstimate } from "./engine-runtime/request"
import { bind as bindEngagementUsage, finalize as finalizeEngagementUsage } from "./engagement-usage"
import { resolveAssignments } from "./assignment-client"
import type { BattleAssignmentDecision } from "@agent-duel/arena-service/assignment-decision"

type ActiveGeneration = {
  readonly id: string
  readonly callIndex: number
  readonly metadata: RequestMetadata
  readonly chunks: string[]
  readonly contextTokens: number
  readonly engagementID?: string
  responseAt?: Date
  firstChunkAt?: Date
  status?: number
  headers?: Readonly<Record<string, string>>
}

type Attempt = {
  readonly generationID: string
  readonly attemptIndex: number
  /** The attempt waited on the user's network or sign-in: its resend is not a retry (docs/arena.md). */
  waited?: boolean
}

type PendingMetrics = GenerationMetrics & {
  readonly runID: string
}

type TelemetryOptions = {
  readonly resolveAssignments?: typeof resolveAssignments
}

const encoder = new TextEncoder()

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const privateResponseKeys = new Set([
  "cost",
  "costdetails",
  "model",
  "modelid",
  "nativefinishreason",
  "openroutermetadata",
  "provider",
  "providermetadata",
  "providername",
  "provideroptions",
  "reasoningdetails",
  "servicetier",
  "systemfingerprint",
  "usage",
])

function sanitizeStoredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => sanitizeStoredValue(child))
  if (!record(value)) return value
  if (value.error !== undefined) {
    return { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "")
      if (privateResponseKeys.has(normalized)) return []
      return [[key, sanitizeStoredValue(child)]]
    }),
  )
}

/**
 * Keep the response usable in memory while removing side-channel metadata from
 * the local research copy. Tool arguments remain strings and are not rewritten.
 */
export function sanitizeStoredResponse(raw: string) {
  const lines = raw.split(/(\r?\n)/)
  if (lines.some((line) => line.startsWith("data:"))) {
    return lines
      .map((line) => {
        if (!line.startsWith("data:")) return line
        const text = line.slice(5).trim()
        if (!text || text === "[DONE]") return line
        try {
          return `data: ${JSON.stringify(ArenaPrivacy.toolCallIDs(sanitizeStoredValue(JSON.parse(text))))}`
        } catch {
          return ""
        }
      })
      .join("")
  }
  try {
    return JSON.stringify(ArenaPrivacy.toolCallIDs(sanitizeStoredValue(JSON.parse(raw))))
  } catch {
    return ""
  }
}

function payloads(raw: string) {
  const values: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!text || text === "[DONE]") continue
    try {
      values.push(JSON.parse(text))
    } catch {
      // Invalid provider data is omitted from the stored privacy copy.
    }
  }
  if (values.length) return values
  try {
    return [JSON.parse(raw)] as unknown[]
  } catch {
    return []
  }
}

function filled(value: unknown) {
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return false
}

/** A chat-completions delta or message that carries text, reasoning or a tool call. */
function messageOutput(value: unknown) {
  if (!record(value)) return false
  return ["content", "reasoning", "reasoning_content", "reasoning_details", "tool_calls", "refusal"].some((key) =>
    filled(value[key]),
  )
}

/** A Responses API output item that carries text, reasoning or a tool call. */
function itemOutput(value: unknown) {
  if (!record(value)) return false
  if (value.type === "function_call" || value.type === "custom_tool_call") return true
  return filled(value.content) || filled(value.summary)
}

/**
 * Whether a response chunk carries model output: a content, reasoning or tool-call delta in a
 * chat-completions stream, a Responses API `*.delta` event or a new tool-call item, or a complete
 * non-streamed message. Blank lines, `:` comments, heartbeats, role-only deltas, usage and finish
 * events are not output, so they do not make a first token.
 */
export function carriesModelOutput(chunk: string) {
  return payloads(chunk).some((value) => {
    if (!record(value)) return false
    if (Array.isArray(value.choices))
      return value.choices.some(
        (choice) => record(choice) && (messageOutput(choice.delta) || messageOutput(choice.message)),
      )
    if (typeof value.type === "string") {
      if (value.type.endsWith(".delta")) return filled(value.delta)
      if (value.type === "response.output_item.added") return itemOutput(value.item)
      return false
    }
    return Array.isArray(value.output) && value.output.some(itemOutput)
  })
}

function finishReason(raw: string): string | undefined {
  for (const value of payloads(raw).toReversed()) {
    if (!record(value)) continue
    if (record(value.response)) {
      const nested: string | undefined = finishReason(JSON.stringify(value.response))
      if (nested) return nested
    }
    if (record(value.delta) && typeof value.delta.stop_reason === "string" && value.delta.stop_reason.trim()) {
      return value.delta.stop_reason
    }
    if (record(value.message) && typeof value.message.stop_reason === "string" && value.message.stop_reason.trim()) {
      return value.message.stop_reason
    }
    if (typeof value.status === "string" && ["completed", "incomplete", "failed"].includes(value.status)) {
      return value.status
    }
    if (!Array.isArray(value.choices)) continue
    for (const choice of value.choices) {
      if (!record(choice)) continue
      const reason = choice.finish_reason ?? choice.finishReason
      if (typeof reason === "string" && reason.trim()) return reason
    }
  }
  return undefined
}

function decisionForResolution(value: unknown): BattleAssignmentDecision | undefined {
  if (!record(value) || typeof value.kind !== "string") return undefined
  switch (value.kind) {
    case "aborted":
      return "aborted"
    case "vote":
      return value.vote === "tie"
        ? "tie"
        : value.vote === "a" || value.vote === "b"
          ? `select:${value.vote}`
          : undefined
    case "early":
      return value.vote === "a" || value.vote === "b" ? `select:${value.vote}` : undefined
    case "stopped":
      return value.resolution === "apply_a"
        ? "select:a"
        : value.resolution === "apply_b"
          ? "select:b"
          : value.resolution === "discard"
            ? "discard"
            : undefined
    default:
      return undefined
  }
}

const zeroUsage: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  attempts: 0,
  latencyMs: 0,
  provenance: "provider",
  version: 2,
}

function unknownCompletedUsage(generation: GenerationDocument): UsageTotals {
  return {
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    attempts: 1,
    latencyMs: generation.completedAt
      ? Math.max(0, generation.completedAt.getTime() - generation.startedAt.getTime())
      : 0,
  }
}

function providerGenerationID(raw: string) {
  for (const value of payloads(raw)) {
    if (!record(value)) continue
    if (typeof value.id === "string" && value.id.trim()) return value.id
  }
  return undefined
}

export function create(store: Store, options?: TelemetryOptions): Telemetry {
  const active = new WeakMap<RequestMetadata, ActiveGeneration>()
  const counters = new Map<string, number>()
  const attempts = new Map<string, Map<string, Attempt>>()
  const pending = new Map<string, PendingMetrics>()
  const revealed = new Set<string>()
  const released = new Set<string>()
  const revealedMetrics = new Map<string, GenerationMetrics>()
  const refreshing = new Set<string>()
  const refreshQueue = new Map<string, Set<string>>()
  const resolveBattleAssignments = options?.resolveAssignments ?? resolveAssignments
  const queues = new Map<string, Promise<void>>()
  const counterSeeds = new Map<string, Promise<void>>()

  // A run's numbering continues from its stored generations. A reply resumes a finished run after
  // an engine restart, and restarting at 0 breaks the unique (runID, callIndex) index, which fails
  // the request before it leaves.
  const nextCallIndex = async (runID: string) => {
    if (!counters.has(runID)) {
      const seed =
        counterSeeds.get(runID) ??
        store
          .generationsForRuns([runID])
          .then((generations) => {
            counters.set(
              runID,
              generations.reduce((next, generation) => Math.max(next, generation.callIndex + 1), 0),
            )
          })
          .finally(() => counterSeeds.delete(runID))
      counterSeeds.set(runID, seed)
      await seed
    }
    const callIndex = counters.get(runID)!
    counters.set(runID, callIndex + 1)
    return callIndex
  }

  const persist = (metrics: PendingMetrics) => {
    const previous = queues.get(metrics.runID) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const existing = (await store.generationsForRuns([metrics.runID])).find(
          (generation) => generation._id === metrics.generationID,
        )
        const usage =
          metrics.usage ?? existing?.usage ?? (existing?.completedAt ? unknownCompletedUsage(existing) : undefined)
        await store.updateGeneration(metrics.generationID, {
          ...(usage ? { usage } : {}),
          ...(metrics.finishReason ? { finishReason: metrics.finishReason } : {}),
        })
        const generations = await store.generationsForRuns([metrics.runID])
        const usages = generations.flatMap((generation) => {
          if (generation.usage) return [generation.usage]
          return generation.completedAt ? [unknownCompletedUsage(generation)] : []
        })
        if (usages.length > 0) {
          await store.updateRun(metrics.runID, { usage: usages.reduce(addUsageTotals, zeroUsage) })
        }
        pending.delete(metrics.generationID)
      })
    queues.set(metrics.runID, current)
    return current.finally(() => {
      if (queues.get(metrics.runID) === current) queues.delete(metrics.runID)
    })
  }

  const retain = async (metrics: PendingMetrics) => {
    // A request cancelled with its battle can still report after the release.
    if (released.has(metrics.runID)) return
    const server = revealedMetrics.get(metrics.generationID)
    const combined = {
      ...metrics,
      usage: server?.usage ?? metrics.usage,
      finishReason: server?.finishReason ?? metrics.finishReason,
    }
    pending.set(metrics.generationID, combined)
    if (revealed.has(metrics.runID)) await persist(combined)
  }

  const refreshRevealedRun = async (runID: string, requestedIDs: readonly string[]) => {
    if (refreshing.has(runID)) {
      const queued = refreshQueue.get(runID) ?? new Set<string>()
      requestedIDs.forEach((generationID) => queued.add(generationID))
      refreshQueue.set(runID, queued)
      return
    }
    refreshing.add(runID)
    try {
      const run = await store.run(runID)
      const turn = run ? await store.turn(run.turnID) : undefined
      const resolution = turn?.resolution
      if (!turn || !resolution || !revealed.has(runID)) return
      const decision = decisionForResolution(resolution)
      if (!decision) return
      const wanted = new Set(requestedIDs)
      // A control-plane write can trail the local reveal by a short interval. Retry a bounded
      // number of times in the background; stream completion and the next prompt never wait.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resolved = await resolveBattleAssignments("battle", turn._id, decision)
          const matching = new Map(
            resolved.assignments.flatMap((assignment) =>
              assignment.metrics.map((metric) => [metric.generationID, metric] as const),
            ),
          )
          for (const [generationID, metric] of matching) revealedMetrics.set(generationID, metric)
          if ([...wanted].every((generationID) => matching.has(generationID))) {
            const generations = await store.generationsForRuns([runID])
            await Promise.all(
              generations.flatMap((generation) => {
                const metric = matching.get(generation._id)
                if (!metric?.usage && !metric?.finishReason) return []
                return [
                  retain({
                    generationID: generation._id,
                    runID,
                    ...(metric.usage ? { usage: metric.usage } : {}),
                    ...(metric.finishReason ? { finishReason: metric.finishReason } : {}),
                  }),
                ]
              }),
            )
            return
          }
        } catch {
          // A reveal retry is best effort; leave unknown usage if the control plane is unavailable.
        }
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 500))
      }
    } finally {
      refreshing.delete(runID)
      const queued = refreshQueue.get(runID)
      if (queued) {
        refreshQueue.delete(runID)
        void refreshRevealedRun(runID, [...queued]).catch(() => undefined)
      }
    }
  }

  const scheduleRefresh = (runID: string, generationIDs: readonly string[]) => {
    const ids = [...new Set(generationIDs)]
    if (ids.length === 0) return
    void refreshRevealedRun(runID, ids).catch(() => undefined)
  }

  return {
    async start(metadata, _body) {
      const id = metadata.generationID
      // Bind before any awaited store work: a new engagement can begin while this generation is
      // being persisted, but its completion must remain attached to the engagement at start.
      const engagementID = bindEngagementUsage(id, {
        runID: metadata.assignment.runID,
        sessionID: metadata.assignment.rootSessionID,
      })
      const callIndex = await nextCallIndex(metadata.assignment.runID)
      const runAttempts = attempts.get(metadata.assignment.runID) ?? new Map<string, Attempt>()
      const previous = runAttempts.get(metadata.requestID)
      // Counts real attempts: the resend after a wait keeps the index of the attempt that waited.
      const attemptIndex = previous ? previous.attemptIndex + (previous.waited ? 0 : 1) : 0
      await store.saveGeneration({
        _id: id,
        runID: metadata.assignment.runID,
        rootSessionID: metadata.assignment.rootSessionID,
        sessionID: metadata.sessionID,
        parentSessionID: metadata.parentSessionID,
        callIndex,
        requestID: metadata.requestID,
        ...(metadata.requestKind ? { requestKind: metadata.requestKind } : {}),
        ...(previous ? { retryParentID: previous.generationID } : {}),
        assignmentID: metadata.assignment.assignmentID,
        requestedModel: metadata.requestedModel,
        requestedReasoning: { effort: "high" },
        ...(engagementID ? { engagementID } : {}),
        ...(metadata.opportunisticCompactionID
          ? { opportunisticCompactionID: metadata.opportunisticCompactionID }
          : {}),
        enforcedReasoning: metadata.enforcedReasoning,
        classification:
          metadata.classification ?? (metadata.sessionID === metadata.assignment.rootSessionID ? "root" : "subagent"),
        startedAt: metadata.startedAt,
      })
      runAttempts.set(metadata.requestID, { generationID: id, attemptIndex })
      attempts.set(metadata.assignment.runID, runAttempts)
      if (previous && !previous.waited) {
        await store.recordGenerationRetry(metadata.assignment.runID, {
          requestID: metadata.requestID,
          generationID: id,
          retryParentID: previous.generationID,
          attemptIndex,
          observedAt: metadata.startedAt,
        })
      }
      if (metadata.sessionID !== metadata.assignment.rootSessionID) {
        await store.addDescendant(metadata.assignment.runID, metadata.sessionID)
      }
      active.set(metadata, {
        id,
        callIndex,
        metadata,
        chunks: [],
        contextTokens: requestTokenEstimate(_body),
        ...(engagementID ? { engagementID } : {}),
      })
    },
    async response({ metadata, status, headers, receivedAt }) {
      const generation = active.get(metadata)
      if (!generation) return
      generation.responseAt = receivedAt
      generation.status = status
      generation.headers = headers
      await store.updateGeneration(generation.id, {
        responseHeadersAt: receivedAt,
        routing: { status, headers },
      })
    },
    rawChunk(metadata, chunk) {
      const generation = active.get(metadata)
      if (!generation) return
      if (!generation.firstChunkAt && carriesModelOutput(chunk)) generation.firstChunkAt = new Date()
      generation.chunks.push(chunk)
    },
    async complete(metadata, completedAt) {
      const generation = active.get(metadata)
      if (!generation) return
      active.delete(metadata)
      const raw = generation.chunks.join("")
      const latencyMs = Math.max(0, completedAt.getTime() - metadata.startedAt.getTime())
      const values = payloads(raw)
      const measured = hasFinalProviderUsage(values) ? parseProviderUsage(values, latencyMs) : undefined
      const finished = finishReason(raw)
      finalizeEngagementUsage({
        generationID: generation.id,
        ...(generation.engagementID ? { engagementID: generation.engagementID } : {}),
        runID: metadata.assignment.runID,
        sessionID: metadata.sessionID,
        rootSessionID: metadata.assignment.rootSessionID,
        classification:
          metadata.classification ?? (metadata.sessionID === metadata.assignment.rootSessionID ? "root" : "subagent"),
        requestKind: metadata.requestKind,
        ...(metadata.opportunisticCompactionID
          ? { opportunisticCompactionID: metadata.opportunisticCompactionID }
          : {}),
        ...(measured ? { usage: measured } : {}),
        contextTokens:
          measured?.completionTokens === null || measured === undefined
            ? generation.contextTokens
            : generation.contextTokens + measured.completionTokens,
        finalizedAt: completedAt,
      })
      const response = sanitizeStoredResponse(raw)
      const responseArtifactID = `${generation.id}|response`
      await store.storeArtifact({
        _id: responseArtifactID,
        runID: metadata.assignment.runID,
        kind: "generation_response",
        mimeType: "application/octet-stream",
        encoding: "utf8",
        compression: "none",
        data: encoder.encode(response),
        createdAt: completedAt,
      })
      await store.updateGeneration(generation.id, {
        completedAt,
        ...(generation.firstChunkAt ? { firstTokenAt: generation.firstChunkAt } : {}),
        responseArtifactID,
        providerGenerationID: providerGenerationID(response),
        payloadHashes: { response: hash(response) },
      })
      await retain({
        generationID: generation.id,
        runID: metadata.assignment.runID,
        ...(measured ? { usage: measured } : {}),
        ...(finished ? { finishReason: finished } : {}),
      })
      if (metadata.opportunisticCompactionID && revealed.has(metadata.assignment.runID)) {
        scheduleRefresh(metadata.assignment.runID, [generation.id])
      }
    },
    async error(metadata, error, at) {
      if (!metadata) return
      const generation = active.get(metadata)
      if (!generation) return
      active.delete(metadata)
      const wait = error instanceof ArenaWaitError ? error.wait : undefined
      if (wait) {
        const attempt = attempts.get(metadata.assignment.runID)?.get(metadata.requestID)
        if (attempt?.generationID === generation.id) attempt.waited = true
      }
      // A refused attempt's only chunk is the error body Arena wrote, not a token from the model.
      const refused = generation.status !== undefined && generation.status >= 400
      const raw = generation.chunks.join("")
      const latencyMs = Math.max(0, at.getTime() - metadata.startedAt.getTime())
      const values = payloads(raw)
      const measured = hasFinalProviderUsage(values) ? parseProviderUsage(values, latencyMs) : undefined
      const finished = finishReason(raw)
      finalizeEngagementUsage({
        generationID: generation.id,
        ...(generation.engagementID ? { engagementID: generation.engagementID } : {}),
        runID: metadata.assignment.runID,
        sessionID: metadata.sessionID,
        rootSessionID: metadata.assignment.rootSessionID,
        classification:
          metadata.classification ?? (metadata.sessionID === metadata.assignment.rootSessionID ? "root" : "subagent"),
        requestKind: metadata.requestKind,
        ...(metadata.opportunisticCompactionID
          ? { opportunisticCompactionID: metadata.opportunisticCompactionID }
          : {}),
        ...(measured ? { usage: measured } : {}),
        contextTokens:
          measured?.completionTokens === null || measured === undefined
            ? generation.contextTokens
            : generation.contextTokens + measured.completionTokens,
        finalizedAt: at,
      })
      const response = sanitizeStoredResponse(raw)
      const hasResponse = generation.responseAt !== undefined || response.length > 0
      const responseArtifactID = `${generation.id}|response`
      if (hasResponse) {
        await store.storeArtifact({
          _id: responseArtifactID,
          runID: metadata.assignment.runID,
          kind: "generation_response",
          mimeType: "application/octet-stream",
          encoding: "utf8",
          compression: "none",
          data: encoder.encode(response),
          createdAt: at,
        })
      }
      await store.updateGeneration(generation.id, {
        completedAt: at,
        ...(generation.firstChunkAt && !refused ? { firstTokenAt: generation.firstChunkAt } : {}),
        ...(hasResponse ? { responseArtifactID } : {}),
        ...(response ? { providerGenerationID: providerGenerationID(response) } : {}),
        ...(hasResponse ? { payloadHashes: { response: hash(response) } } : {}),
        error: "Arena contestant request failed",
        ...(wait ? { wait } : {}),
      })
      await retain({
        generationID: generation.id,
        runID: metadata.assignment.runID,
        ...(measured ? { usage: measured } : {}),
        ...(finished ? { finishReason: finished } : {}),
      })
      if (metadata.opportunisticCompactionID && revealed.has(metadata.assignment.runID)) {
        scheduleRefresh(metadata.assignment.runID, [generation.id])
      }
    },
    release(input) {
      const runIDs = new Set(input.runIDs)
      runIDs.forEach((runID) => released.add(runID))
      for (const [generationID, metrics] of pending) {
        if (runIDs.has(metrics.runID)) pending.delete(generationID)
      }
    },
    async reveal(input) {
      const runIDs = input.runIDs.filter((runID) => !released.has(runID))
      if (runIDs.length === 0) return
      runIDs.forEach((runID) => revealed.add(runID))
      input.metrics.forEach((metrics) => revealedMetrics.set(metrics.generationID, metrics))
      const generations = await store.generationsForRuns(runIDs)
      await Promise.all(
        generations.flatMap((generation) => {
          const local = pending.get(generation._id)
          const server = revealedMetrics.get(generation._id)
          if (!local && !server && !generation.completedAt) return []
          return [
            persist({
              generationID: generation._id,
              runID: generation.runID,
              usage: server?.usage ?? local?.usage,
              finishReason: server?.finishReason ?? local?.finishReason,
            }),
          ]
        }),
      )
      for (const runID of runIDs) {
        scheduleRefresh(
          runID,
          generations
            .filter((generation) => generation.runID === runID && generation.opportunisticCompactionID)
            .map((generation) => generation._id),
        )
      }
    },
  }
}

export * as ArenaTelemetry from "./telemetry"
