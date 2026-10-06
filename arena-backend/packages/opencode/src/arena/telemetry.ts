import { createHash } from "crypto"
import type { Store } from "./mongo"
import type { RequestMetadata, Telemetry } from "./proxy"
import type { GenerationMetrics, UsageTotals } from "./records"
import { ArenaPrivacy } from "./privacy"

type ActiveGeneration = {
  readonly id: string
  readonly callIndex: number
  readonly metadata: RequestMetadata
  readonly chunks: string[]
  responseAt?: Date
  firstChunkAt?: Date
  status?: number
  headers?: Readonly<Record<string, string>>
}

type Attempt = {
  readonly generationID: string
  readonly attemptIndex: number
}

type PendingMetrics = GenerationMetrics & {
  readonly runID: string
}

const encoder = new TextEncoder()

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function usageFromPayload(value: unknown, latencyMs: number): UsageTotals | undefined {
  if (!record(value)) return undefined
  const source = record(value.usage)
    ? value.usage
    : record(value.data) && record(value.data.usage)
      ? value.data.usage
      : undefined
  if (!source) return undefined
  const promptDetails = record(source.prompt_tokens_details) ? source.prompt_tokens_details : undefined
  const completionDetails = record(source.completion_tokens_details) ? source.completion_tokens_details : undefined
  const cacheDetails = record(source.cache_tokens) ? source.cache_tokens : undefined
  const promptTokens = number(source.prompt_tokens ?? source.input_tokens)
  const completionTokens = number(source.completion_tokens ?? source.output_tokens)
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: number(completionDetails?.reasoning_tokens ?? source.reasoning_tokens),
    totalTokens: number(source.total_tokens) || promptTokens + completionTokens,
    cacheReadTokens: number(promptDetails?.cached_tokens ?? cacheDetails?.read ?? source.cache_read_tokens),
    cacheWriteTokens: number(cacheDetails?.write ?? source.cache_write_tokens),
    cost: number(source.cost ?? value.cost),
    attempts: 1,
    latencyMs,
  }
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

function terminalPayload(raw: string) {
  return payloads(raw).findLast((value) => record(value) && value.usage !== undefined)
}

function finishReason(raw: string) {
  for (const value of payloads(raw).toReversed()) {
    if (!record(value)) continue
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

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cost: left.cost + right.cost,
    attempts: left.attempts + right.attempts,
    latencyMs: left.latencyMs + right.latencyMs,
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
}

function providerGenerationID(raw: string) {
  for (const value of payloads(raw)) {
    if (!record(value)) continue
    if (typeof value.id === "string" && value.id.trim()) return value.id
  }
  return undefined
}

export function create(store: Store): Telemetry {
  const active = new WeakMap<RequestMetadata, ActiveGeneration>()
  const counters = new Map<string, number>()
  const attempts = new Map<string, Map<string, Attempt>>()
  const pending = new Map<string, PendingMetrics>()
  const revealed = new Set<string>()
  const revealedMetrics = new Map<string, GenerationMetrics>()
  const queues = new Map<string, Promise<void>>()

  const persist = (metrics: PendingMetrics) => {
    const previous = queues.get(metrics.runID) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await store.updateGeneration(metrics.generationID, {
          ...(metrics.usage ? { usage: metrics.usage } : {}),
          ...(metrics.finishReason ? { finishReason: metrics.finishReason } : {}),
        })
        const generations = await store.generationsForRuns([metrics.runID])
        const usages = generations.flatMap((generation) => (generation.usage ? [generation.usage] : []))
        if (usages.length > 0) {
          await store.updateRun(metrics.runID, { usage: usages.reduce(addUsage, zeroUsage) })
        }
        pending.delete(metrics.generationID)
      })
    queues.set(metrics.runID, current)
    return current.finally(() => {
      if (queues.get(metrics.runID) === current) queues.delete(metrics.runID)
    })
  }

  const retain = async (metrics: PendingMetrics) => {
    const server = revealedMetrics.get(metrics.generationID)
    const combined = {
      ...metrics,
      usage: server?.usage ?? metrics.usage,
      finishReason: server?.finishReason ?? metrics.finishReason,
    }
    pending.set(metrics.generationID, combined)
    if (revealed.has(metrics.runID)) await persist(combined)
  }

  return {
    async start(metadata, _body) {
      const callIndex = counters.get(metadata.assignment.runID) ?? 0
      counters.set(metadata.assignment.runID, callIndex + 1)
      const id = metadata.generationID
      const runAttempts = attempts.get(metadata.assignment.runID) ?? new Map<string, Attempt>()
      const previous = runAttempts.get(metadata.requestID)
      const attemptIndex = previous ? previous.attemptIndex + 1 : 0
      await store.saveGeneration({
        _id: id,
        runID: metadata.assignment.runID,
        rootSessionID: metadata.assignment.rootSessionID,
        sessionID: metadata.sessionID,
        parentSessionID: metadata.parentSessionID,
        callIndex,
        requestID: metadata.requestID,
        ...(previous ? { retryParentID: previous.generationID } : {}),
        assignmentID: metadata.assignment.assignmentID,
        requestedModel: metadata.requestedModel,
        requestedReasoning: { effort: "high" },
        enforcedReasoning: metadata.enforcedReasoning,
        classification:
          metadata.classification ?? (metadata.sessionID === metadata.assignment.rootSessionID ? "root" : "subagent"),
        startedAt: metadata.startedAt,
      })
      runAttempts.set(metadata.requestID, { generationID: id, attemptIndex })
      attempts.set(metadata.assignment.runID, runAttempts)
      if (previous) {
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
      active.set(metadata, { id, callIndex, metadata, chunks: [] })
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
      if (!generation.firstChunkAt && chunk.length > 0) generation.firstChunkAt = new Date()
      generation.chunks.push(chunk)
    },
    async complete(metadata, completedAt) {
      const generation = active.get(metadata)
      if (!generation) return
      active.delete(metadata)
      const raw = generation.chunks.join("")
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
      const measured = usageFromPayload(
        terminalPayload(raw),
        Math.max(0, completedAt.getTime() - metadata.startedAt.getTime()),
      )
      const finished = finishReason(raw)
      if (measured || finished) {
        await retain({
          generationID: generation.id,
          runID: metadata.assignment.runID,
          ...(measured ? { usage: measured } : {}),
          ...(finished ? { finishReason: finished } : {}),
        })
      }
    },
    async error(metadata, _error, at) {
      if (!metadata) return
      const generation = active.get(metadata)
      if (!generation) return
      active.delete(metadata)
      const raw = generation.chunks.join("")
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
        ...(generation.firstChunkAt ? { firstTokenAt: generation.firstChunkAt } : {}),
        ...(hasResponse ? { responseArtifactID } : {}),
        ...(response ? { providerGenerationID: providerGenerationID(response) } : {}),
        ...(hasResponse ? { payloadHashes: { response: hash(response) } } : {}),
        error: "Arena contestant request failed",
      })
      const measured = usageFromPayload(terminalPayload(raw), Math.max(0, at.getTime() - metadata.startedAt.getTime()))
      const finished = finishReason(raw)
      if (measured || finished) {
        await retain({
          generationID: generation.id,
          runID: metadata.assignment.runID,
          ...(measured ? { usage: measured } : {}),
          ...(finished ? { finishReason: finished } : {}),
        })
      }
    },
    async reveal(input) {
      input.runIDs.forEach((runID) => revealed.add(runID))
      input.metrics.forEach((metrics) => revealedMetrics.set(metrics.generationID, metrics))
      const generations = await store.generationsForRuns(input.runIDs)
      await Promise.all(
        generations.flatMap((generation) => {
          const local = pending.get(generation._id)
          const server = revealedMetrics.get(generation._id)
          if (!local && !server) return []
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
    },
  }
}

export * as ArenaTelemetry from "./telemetry"
