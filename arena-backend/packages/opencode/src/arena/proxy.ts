import { randomUUID } from "crypto"
import { contestant } from "./model-profile"
import type { GenerationFailureKind, GenerationFailurePhase, GenerationMetrics } from "./records"
import {
  compactionRequiredError,
  contentFilterError,
  contentFilterFinish,
  contentFilterMessage,
  contentFilterRefusal,
  filteredStreamChunk,
  networkUnavailableError,
  paymentError,
  readCompactionOverflow,
  readCompactionRequired,
  readContentFilter,
  readNetworkUnavailable,
  readPaymentError,
  readSessionRejected,
  readSingleAgentAllowance,
  refusalUsage,
  retryableStreamError,
  sessionRejectedError,
  singleAgentAllowanceError,
} from "@agent-duel/arena-service/request-error"
import { COMPACTION_HEADER, COMPACTION_OFFER } from "@agent-duel/arena-service/request-budget"
import { HEARTBEAT_HEADER, REPLAY_PATH, REPLAY_UNAVAILABLE_LINE } from "@agent-duel/arena-service/stream-recovery"
import { KEEP_ALIVE_HEADER } from "@agent-duel/arena-service/keep-alive"
import { mediaUnavailableError, readMediaMissing, readMediaUnavailable } from "@agent-duel/arena-service/media"
import type { KeepAlive, Ping, PingResult } from "./keep-alive"
import {
  forgetUploads,
  pauseReferences,
  referenceMedia,
  referencesSupported,
  storePaused,
  uploadMedia,
  type Media,
} from "./media-reference"
import { REQUEST_BYTES_LIMIT } from "./engine-runtime/request-size"

// The control plane lost its upload route after this request was sized for references.
const MEDIA_RESIZE_ERROR = { error: { message: "Arena media has to be sent inline", type: "arena_media_inline" } }

/** An upload that did not succeed: refused, a control plane without the route, or a failure to send. */
type UploadFailure = Response | "unsupported" | { readonly thrown: unknown }

export type Assignment = {
  readonly runID: string
  readonly rootSessionID: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly telemetry: boolean
  /** First prompt in this scope; persisted by the single-agent rating record. */
  readonly reasoningFromMessageID?: string
  readonly modelSize?: "medium" | "frontier"
}

export type RequestMetadata = {
  readonly assignment: Assignment
  readonly generationID: string
  readonly requestID: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly requestedModel: string
  readonly enforcedReasoning: { readonly effort: "high" | "xhigh" }
  readonly classification?: "compaction"
  /** What the engine asked for (`x-arena-generation-classification`); absent on old callers. */
  readonly requestKind?: "generation" | "compaction" | "utility"
  readonly startedAt: Date
}

/**
 * The attempt failed for a reason on the user's side, and the engine waits instead of spending a
 * retry: no network (`arena_network_unavailable`), or a session the control plane rejected
 * (`arena_session_rejected`), which only a new sign-in fixes.
 */
export class ArenaWaitError extends Error {
  override readonly name = "ArenaWaitError"
  constructor(readonly wait: "network" | "sign-in") {
    super(wait === "network" ? "Arena network is unavailable" : "Arena session was rejected")
  }
}

function requestKind(value: string | null) {
  return value === "generation" || value === "compaction" || value === "utility" ? value : undefined
}

export type GenerationFailure = {
  readonly phase: GenerationFailurePhase
  readonly kind: GenerationFailureKind
}

export interface Telemetry {
  readonly start?: (metadata: RequestMetadata, body: Readonly<Record<string, unknown>>) => void | Promise<void>
  readonly dispatched?: (input: {
    readonly metadata: RequestMetadata
    readonly dispatchedAt: Date
    readonly requestBytes: number
  }) => void | Promise<void>
  readonly response?: (input: {
    readonly metadata: RequestMetadata
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly receivedAt: Date
  }) => void | Promise<void>
  readonly rawChunk?: (metadata: RequestMetadata, chunk: string) => void
  readonly complete?: (metadata: RequestMetadata, completedAt: Date) => void | Promise<void>
  readonly error?: (
    metadata: RequestMetadata | undefined,
    error: unknown,
    at: Date,
    failure?: GenerationFailure,
  ) => void | Promise<void>
  readonly reveal?: (input: {
    readonly runIDs: readonly string[]
    readonly metrics: readonly GenerationMetrics[]
  }) => void | Promise<void>
  /** The runs' battle ended without a reveal: their usage is never persisted, so stop holding it. */
  readonly release?: (input: { readonly runIDs: readonly string[] }) => void | Promise<void>
}

export type ProxyOptions = {
  /** Base of the assigned OpenRouter routes. `fetch` adds whatever credential they need. */
  readonly upstream: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly telemetry?: Telemetry
  readonly keepAlive?: KeepAlive
  /** Upload images and PDFs once and name them in the request (`media-reference.ts`): the hosted control plane. */
  readonly mediaByReference?: boolean
  /**
   * Sends an uploaded file to its storage URL. Defaults to a plain `fetch`, and is never `fetch`
   * above: the storage host must not get the account's credential.
   */
  readonly mediaUpload?: (input: string, init: RequestInit) => Promise<Response>
  /**
   * Runs when a content filter refuses a session's main request, before the model call sees the
   * refusal. Core starts the steps a refused run must not take as soon as that call fails.
   */
  readonly contentFilter?: (sessionID: string) => Promise<void> | void
}

// A filter handler that never settles must not hold the refusal back from the model call.
const CONTENT_FILTER_HANDLER_MS = 5_000

async function settleContentFilter(run: () => Promise<void> | void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve()
        .then(run)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CONTENT_FILTER_HANDLER_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type StreamProgress = {
  readonly generationID: string
  readonly headersAt: number
  chunks: number
  bytes: number
  lastChunkAt?: number
  endedAt?: number
  savingAt?: number
  savedAt?: number
  closedAt?: number
  cancelledAt?: number
  failedAt?: number
  stalledAt?: number
  replayedAt?: number
  failure?: "read" | "read-aborted" | "save" | "forward" | "cut-off" | "stalled" | "replay-unavailable"
}

// Missed heartbeats before a stream counts as dead. The control plane sends one at least every
// `HEARTBEAT_MS` while a stream is quiet, so silence this long is the connection, not the model.
const STALL_HEARTBEATS = 3

function stallDeadline(headers: Headers) {
  const heartbeatMs = Number(headers.get(HEARTBEAT_HEADER))
  return Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs * STALL_HEARTBEATS : undefined
}

/** How a stream whose connection dies gets its response back (`stream-recovery.ts`). */
type StreamRecovery = {
  readonly stallMs: number
  /** Ends the dead request, so the control plane stops streaming into it. */
  readonly abandon: () => void
  readonly replay: () => Promise<Response>
}

// Each session's latest contestant stream, sizes and times only. When the idle deadline fires, it
// tells a response that never ended apart from one that ended but never reached the model call.
const progress = new Map<string, StreamProgress>()
const PROGRESS_SESSIONS = 256

function trackProgress(sessionID: string, generationID: string) {
  const record: StreamProgress = { generationID, headersAt: Date.now(), chunks: 0, bytes: 0 }
  progress.delete(sessionID)
  progress.set(sessionID, record)
  if (progress.size > PROGRESS_SESSIONS) progress.delete(progress.keys().next().value!)
  return record
}

/** How long ago each step of the session's latest contestant stream happened. */
export function streamProgress(sessionID: string, now = Date.now()) {
  const record = progress.get(sessionID)
  if (!record) return undefined
  const ago = (at: number | undefined) => (at === undefined ? undefined : now - at)
  return Object.fromEntries(
    Object.entries({
      generationID: record.generationID,
      chunks: record.chunks,
      bytes: record.bytes,
      headersMsAgo: ago(record.headersAt),
      lastChunkMsAgo: ago(record.lastChunkAt),
      endedMsAgo: ago(record.endedAt),
      savingMsAgo: ago(record.savingAt),
      savedMsAgo: ago(record.savedAt),
      closedMsAgo: ago(record.closedAt),
      cancelledMsAgo: ago(record.cancelledAt),
      failedMsAgo: ago(record.failedAt),
      stalledMsAgo: ago(record.stalledAt),
      replayedMsAgo: ago(record.replayedAt),
      failure: record.failure,
    }).filter(([, value]) => value !== undefined),
  )
}

export class AssignmentRegistry {
  readonly assignments = new Map<string, Assignment>()

  assign(sessionID: string, assignment: Assignment) {
    const existing = this.assignments.get(sessionID)
    if (existing && existing.runID !== assignment.runID) {
      throw new Error(`Arena session already belongs to another run: ${sessionID}`)
    }
    this.assignments.set(sessionID, assignment)
    return assignment
  }

  replaceSingle(sessionID: string, assignment: Assignment) {
    const existing = this.assignments.get(sessionID)
    if (existing?.telemetry || assignment.telemetry) {
      throw new Error(`Arena battle assignment cannot be replaced: ${sessionID}`)
    }
    this.assignments.set(sessionID, assignment)
    return assignment
  }

  resolve(sessionID: string, parentSessionID?: string) {
    const direct = this.assignments.get(sessionID)
    if (direct) return direct
    if (!parentSessionID) throw new Error(`Arena session is not assigned: ${sessionID}`)
    const parent = this.assignments.get(parentSessionID)
    if (!parent) throw new Error(`Arena parent session is not assigned: ${parentSessionID}`)
    this.assignments.set(sessionID, parent)
    return parent
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function retryableTransport(error: unknown) {
  if (!record(error) || error.name === "AbortError") return false
  return error.code === "ConnectionRefused" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET"
}

function hasReasonMessage(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false
  if (value instanceof Error) return value.message === expected || hasReasonMessage(value.cause, expected, depth + 1)
  if (typeof value === "string") return value === expected
  if (record(value)) return value.message === expected || hasReasonMessage(value.cause, expected, depth + 1)
  return false
}

function sessionHeaders(headers: Headers) {
  const sessionID = headers.get("x-session-id")?.trim() || headers.get("x-session-affinity")?.trim()
  if (!sessionID) throw new Error("Arena proxy request is missing its session ID")
  const requestID = headers.get("x-arena-request-id")?.trim()
  if (!requestID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestID)) {
    throw new Error("Arena proxy request is missing its internal request ID")
  }
  const parentSessionID = headers.get("x-parent-session-id")?.trim() || undefined
  return { requestID, sessionID, parentSessionID }
}

export function rewriteBody(body: unknown, assignment: Assignment): Record<string, unknown> {
  if (!record(body)) throw new Error("Arena proxy request body must be an object")
  const expectedModel = assignment.modelSize === "medium" ? "medium" : contestant.id
  if (body.model !== expectedModel) {
    throw new Error("Arena proxy request used an unexpected contestant transport model")
  }
  const { provider: _provider, ...safe } = body
  return {
    ...safe,
    model: expectedModel,
    reasoning: { effort: assignment.modelSize === "medium" ? "xhigh" : "high" },
    stream_options: record(body.stream_options)
      ? { ...body.stream_options, include_usage: true }
      : { include_usage: true },
  }
}

function retryableStreamPayload() {
  // The provider SDK forwards value.error as the stream error; keep the retry marker inside it.
  return {
    error: {
      message: "Provider response stream failed",
      type: "error",
      error: { code: "server_error" },
    },
  }
}

export function sanitizePayload(value: unknown, generationID: string, stream = false): unknown {
  if (!record(value)) return value
  const blocked = stream && filteredStreamChunk(value, generationID)
  if (blocked) return blocked
  if (value.error !== undefined) {
    if (
      stream &&
      record(value.error) &&
      (value.error.type === "arena_retryable_stream_error" ||
        (value.error.type !== "arena_upstream_error" && retryableStreamError(value.error)))
    )
      return retryableStreamPayload()
    return {
      error: {
        message: "Arena contestant request failed",
        type: "arena_upstream_error",
      },
    }
  }

  const sanitized = { ...value }
  if (Array.isArray(sanitized.choices)) {
    sanitized.choices = sanitized.choices.map((choice) => {
      if (!record(choice)) return choice
      const { native_finish_reason, ...safe } = choice
      // OpenRouter can label a truncated tool call as tool_calls. Normalize before the SDK
      // flushes it as an executable call with {} in place of its incomplete arguments.
      if (["length", "max_tokens", "max_output_tokens"].includes(String(native_finish_reason))) {
        safe.finish_reason = "length"
      }
      // A refusal is caught before this runs for the model call, so this is only its stored record:
      // keep the reason once the native field goes.
      if (native_finish_reason === "content_filter") safe.finish_reason = "content_filter"
      return safe
    })
  }
  if ("id" in sanitized) sanitized.id = generationID
  delete sanitized.model
  delete sanitized.model_id
  delete sanitized.provider
  delete sanitized.provider_name
  delete sanitized.openrouter_metadata
  delete sanitized.system_fingerprint
  if (record(sanitized.data)) {
    const data = { ...sanitized.data }
    delete data.model
    delete data.model_id
    delete data.provider
    delete data.provider_name
    delete data.openrouter_metadata
    sanitized.data = data
  }
  return sanitized
}

/**
 * What the records keep of a refused complete response: its answer and usage under the
 * `content_filter` finish a filtered stream leaves. The model call still gets the neutral error.
 * `raw` is the provider's response, or the service's refusal with the usage it kept.
 */
function filteredResponseRecord(raw: unknown, generationID: string) {
  if (record(raw) && raw.error === undefined && contentFilterFinish(raw)) return sanitizePayload(raw, generationID)
  const usage = refusalUsage(raw)
  return {
    id: generationID,
    choices: [{ index: 0, message: {}, finish_reason: "content_filter" }],
    ...(usage ? { usage } : {}),
  }
}

// Some routes report tool_calls for truncated JSON even in native_finish_reason. Usage can
// arrive after that finish chunk. Correct the final reason before the SDK flushes pending calls
// as {}, while continuing to forward complete tools and partial output immediately.
function normalizeToolCutoff(limit: unknown) {
  const choices = new Map<number, { finish?: string; arguments: Map<number, string> }>()
  let tokens = 0
  return (value: unknown): unknown => {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return value
    if (!record(value) || !Array.isArray(value.choices)) return value
    if (record(value.usage) && typeof value.usage.completion_tokens === "number") {
      tokens = value.usage.completion_tokens
    }
    for (const choice of value.choices) {
      if (!record(choice)) continue
      const index = typeof choice.index === "number" ? choice.index : 0
      const state = choices.get(index) ?? { arguments: new Map<number, string>() }
      choices.set(index, state)
      if (typeof choice.finish_reason === "string") state.finish = choice.finish_reason
      const delta = choice.delta
      if (!record(delta) || !Array.isArray(delta.tool_calls)) continue
      for (const call of delta.tool_calls) {
        if (!record(call) || typeof call.index !== "number") continue
        const args = record(call.function) && typeof call.function.arguments === "string" ? call.function.arguments : ""
        state.arguments.set(call.index, (state.arguments.get(call.index) ?? "") + args)
      }
    }
    if (!Number.isFinite(tokens) || tokens < limit) return value
    const normalized = [...value.choices]
    for (const [index, state] of choices) {
      if (state.finish !== "tool_calls") continue
      const incomplete = [...state.arguments.values()].some((args) => {
        try {
          JSON.parse(args)
          return false
        } catch {
          return true
        }
      })
      if (!incomplete) continue
      state.finish = "length"
      const position = normalized.findIndex((choice) => record(choice) && (choice.index ?? 0) === index)
      if (position === -1) normalized.push({ index, delta: {}, finish_reason: "length" })
      else normalized[position] = { ...normalized[position], finish_reason: "length" }
    }
    return { ...value, choices: normalized }
  }
}

function responseHeaders(source: Headers) {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

const privateHeaderNames = new Set([
  "authorization",
  "cookie",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "www-authenticate",
  "x-api-key",
])

function researchHeaders(source: Headers) {
  return Object.fromEntries(
    Array.from(source.entries()).filter(([name]) => {
      const normalized = name.toLowerCase()
      return (
        !privateHeaderNames.has(normalized) &&
        !normalized.includes("model") &&
        !normalized.includes("provider") &&
        !normalized.includes("openrouter") &&
        !normalized.includes("fingerprint")
      )
    }),
  )
}

function sanitizeLine(
  line: string,
  generationID: string,
  normalize: (value: unknown) => unknown,
  filtered: () => void,
) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw || raw === "[DONE]") return line
  try {
    const value: unknown = JSON.parse(raw)
    const blocked = record(value) && filteredStreamChunk(value, generationID)
    if (blocked) {
      filtered()
      // The filter finish can carry the call's usage; keep it so the failed generation records it.
      const kept = record(value) && record(value.usage) ? { ...blocked, usage: value.usage } : blocked
      return `data: ${JSON.stringify(kept)}`
    }
    return `data: ${JSON.stringify(normalize(sanitizePayload(value, generationID, true)))}`
  } catch {
    return (
      "data: " + JSON.stringify({ error: { message: "Provider response stream failed", type: "arena_stream_error" } })
    )
  }
}

const terminalEventTypes = new Set(["response.completed", "response.incomplete", "response.failed", "error"])

/** Whether an SSE line is one a provider sends only at the end of a response. */
function endsResponse(line: string) {
  if (!line.startsWith("data:")) return false
  const raw = line.slice("data:".length).trim()
  if (raw === "[DONE]") return true
  if (!raw.includes('"finish_reason":"') && !raw.includes('"type":"') && !raw.includes('"error"')) return false
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.error !== undefined) return true
    if (typeof value.type === "string" && terminalEventTypes.has(value.type)) return true
    return (
      Array.isArray(value.choices) &&
      value.choices.some((choice) => typeof (choice as Record<string, unknown> | null)?.finish_reason === "string")
    )
  } catch {
    return false
  }
}

function isDataLine(line: string) {
  return line.startsWith("data:")
}

async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number | undefined) {
  if (ms === undefined) return reader.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function sanitizeStream(
  stream: ReadableStream<Uint8Array>,
  generationID: string,
  metadata: RequestMetadata,
  maxTokens: unknown,
  telemetry?: Telemetry,
  signal?: AbortSignal,
  recovery?: StreamRecovery,
  onEnd?: (complete: boolean) => void,
  onBlocked?: () => Promise<void>,
) {
  const normalize = normalizeToolCutoff(maxTokens)
  let reader = stream.getReader()
  let decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const tracked = trackProgress(metadata.sessionID, generationID)
  let pending = ""
  let settled = false
  let finished = false
  let blocked = false
  const sanitize = (line: string) =>
    sanitizeLine(line, generationID, normalize, () => {
      blocked = true
    })
  // The SDK emits its finish on EOF. Once a filter has finished the choice, a later transport
  // failure must not replace it with a retryable error, or leave its prompt armed for cache pings.
  // `rest` and `initialPending` carry the part of the current read batch after the filter finish, so
  // a usage chunk that arrived in the same batch is still recorded.
  const finishBlocked = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    rest: readonly string[] = [],
    initialPending = "",
  ) => {
    settled = true
    onEnd?.(false)
    if (open) emit(controller, "")
    controller.close()
    tracked.closedAt = Date.now()
    // Let the service finish recording usage and the response after its final choice. Only the
    // client stream is closed above; a server that never closes its tail must not hold the reader.
    const timeout = setTimeout(() => void reader.cancel().catch(() => undefined), 5_000)
    const feed = (line: string) => {
      if (isDataLine(line)) telemetry?.rawChunk?.(metadata, `${sanitize(line)}\n`)
    }
    try {
      // Usage can arrive after the filter finish; keep it for the failed generation's metrics.
      for (const line of rest) feed(line)
      let tail = initialPending
      while (true) {
        const next = await reader.read()
        if (next.done) break
        tail += decoder.decode(next.value, { stream: true })
        const lines = tail.split("\n")
        tail = lines.pop() ?? ""
        for (const line of lines) feed(line)
      }
      tail += decoder.decode()
      feed(tail)
      await telemetry?.error?.(metadata, new Error(contentFilterMessage), new Date(), {
        phase: "stream",
        kind: "content_filter",
      })
    } finally {
      clearTimeout(timeout)
      await reader.cancel().catch(() => undefined)
    }
  }
  // Data lines the model call has received. A replay resends the whole response, so it skips them.
  let delivered = 0
  let skip = 0
  let replayed = false
  let stallMs = recovery?.stallMs
  // Whether the model call has data lines of an event whose closing blank line it has not received.
  // An error written into that event joins its data, the SDK cannot parse it, and a retryable
  // failure ends the run instead. Every error here closes the open event first.
  let open = false
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, line: string, fresh = false) => {
    if (open && (fresh || line.startsWith('data: {"error":'))) controller.enqueue(encoder.encode("\n"))
    const text = `${line}\n`
    telemetry?.rawChunk?.(metadata, text)
    controller.enqueue(encoder.encode(text))
    open = line !== ""
  }
  const errorEvent = () => `${open ? "\n" : ""}data: ${JSON.stringify(retryableStreamPayload())}\n\n`
  const failRetryable = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: NonNullable<StreamProgress["failure"]>,
    message: string,
  ) => {
    settled = true
    onEnd?.(false)
    tracked.failedAt = Date.now()
    tracked.failure = failure
    const kind: GenerationFailureKind =
      failure === "stalled"
        ? "stream_stalled"
        : failure === "cut-off"
          ? "stream_cut_off"
          : failure === "replay-unavailable"
            ? "replay_unavailable"
            : "stream_read"
    try {
      await telemetry?.error?.(metadata, new Error(message), new Date(), { phase: "stream", kind })
    } catch {
      controller.error(new Error("Arena telemetry persistence failed"))
      return
    }
    controller.enqueue(encoder.encode(errorEvent()))
    controller.close()
  }
  // The connection died without a close. Fetch the recorded response once, from a new connection.
  const replay = async () => {
    if (!recovery || replayed) return false
    replayed = true
    recovery.abandon()
    void reader.cancel().catch(() => undefined)
    const response = await recovery.replay().catch(() => undefined)
    const type = response?.headers.get("content-type") ?? ""
    if (!response?.ok || !response.body || !type.includes("text/event-stream")) {
      await response?.body?.cancel().catch(() => undefined)
      console.warn("[arena-proxy] Contestant stream went quiet and could not be replayed", {
        generationID,
        status: response?.status,
        delivered,
      })
      return false
    }
    console.warn("[arena-proxy] Contestant stream went quiet; replaying its response", { generationID, delivered })
    tracked.replayedAt = Date.now()
    // The replay keeps its own heartbeats while it waits for the original response to finish.
    stallMs = stallDeadline(response.headers)
    reader = response.body.getReader()
    decoder = new TextDecoder()
    pending = ""
    skip = delivered
    return true
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let reading = false
      try {
        // A pull that emits nothing may never be called again. Keep reading a fragmented SSE line.
        while (true) {
          reading = true
          const next = await readWithin(reader, stallMs)
          reading = false
          if (settled) return
          if (next === "stalled") {
            tracked.stalledAt = Date.now()
            if (await replay()) continue
            if (settled) return
            await failRetryable(controller, "stalled", "Arena contestant stream stalled")
            return
          }
          if (next.done) {
            tracked.endedAt = Date.now()
            const tail = decoder.decode()
            pending += tail
            // A last line without its newline is a whole line only if it ends the response; anything
            // else is where the bytes ran out, and the model call gets the cut-off error instead.
            if (pending && skip === 0 && (finished || endsResponse(pending))) {
              finished = true
              const sanitized = sanitize(pending)
              if (blocked) await onBlocked?.()
              if (settled) return
              emit(controller, sanitized, blocked)
              if (blocked) return finishBlocked(controller)
            }
            if (finished && open) emit(controller, "")
            if (!finished) {
              // A hosting time limit or dropped connection ends the body cleanly. Without a finish or
              // [DONE] the response was cut off, and accepting it would end the run as complete.
              await failRetryable(controller, "cut-off", "Arena contestant stream was cut off")
              return
            }
            tracked.savingAt = Date.now()
            await telemetry?.complete?.(metadata, new Date())
            tracked.savedAt = Date.now()
            settled = true
            controller.close()
            tracked.closedAt = Date.now()
            onEnd?.(true)
            return
          }
          const chunk = next.value
          tracked.chunks++
          tracked.bytes += chunk.byteLength
          tracked.lastChunkAt = Date.now()
          const raw = decoder.decode(chunk, { stream: true })
          pending += raw
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          if (!lines.length) continue
          let forwarded = false
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (replayed && line.trim() === REPLAY_UNAVAILABLE_LINE) {
              await failRetryable(controller, "replay-unavailable", "Arena contestant response could not be replayed")
              return
            }
            if (skip > 0) {
              if (isDataLine(line)) skip--
              continue
            }
            finished ||= endsResponse(line)
            if (isDataLine(line)) delivered++
            const sanitized = sanitize(line)
            if (blocked) await onBlocked?.()
            if (settled) return
            emit(controller, sanitized, blocked)
            if (blocked) return finishBlocked(controller, lines.slice(i + 1), pending)
            forwarded = true
          }
          if (forwarded) return
        }
      } catch {
        if (settled) return
        settled = true
        onEnd?.(false)
        tracked.failedAt = Date.now()
        tracked.failure = reading
          ? signal?.aborted
            ? "read-aborted"
            : "read"
          : tracked.savingAt !== undefined && tracked.savedAt === undefined
            ? "save"
            : "forward"
        const kind: GenerationFailureKind = hasReasonMessage(signal?.reason, "SSE read timed out")
          ? "stream_timeout"
          : signal?.aborted
            ? "aborted"
            : "stream_read"
        try {
          await telemetry?.error?.(metadata, new Error("Provider response stream failed"), new Date(), {
            phase: "stream",
            kind,
          })
        } catch {
          controller.error(new Error("Arena telemetry persistence failed"))
          return
        }
        if (reading && !signal?.aborted) {
          controller.enqueue(encoder.encode(errorEvent()))
          controller.close()
          return
        }
        controller.error(new Error("Provider response stream failed"))
      }
    },
    async cancel(reason) {
      if (settled) return
      settled = true
      onEnd?.(false)
      tracked.cancelledAt = Date.now()
      const kind: GenerationFailureKind =
        hasReasonMessage(reason, "SSE read timed out") || hasReasonMessage(signal?.reason, "SSE read timed out")
          ? "stream_timeout"
          : "stream_cancelled"
      try {
        await reader.cancel(reason)
      } finally {
        await telemetry?.error?.(metadata, new Error("Arena contestant stream was cancelled"), new Date(), {
          phase: "stream",
          kind,
        })
      }
    },
  })
}

function upstreamPath(request: Request) {
  const path = new URL(request.url).pathname
  if (path.endsWith("/chat/completions")) return "/api/v1/chat/completions"
  if (path.endsWith("/responses")) return "/api/v1/responses"
  throw new Error(`Arena proxy endpoint is not supported: ${path}`)
}

// A cache read answers in seconds; a ping that lands on a cold provider writes the whole prompt.
const PING_TIMEOUT_MS = 120_000

// Re-sends a request that ended, with a one-token answer, so the provider reads its cached prompt
// and keeps it (`keep-alive.ts`). It carries no generation ID, so the proxy records nothing, and
// nothing here reaches telemetry or the stream progress the idle deadline reads.
async function keepAlivePing(
  execute: NonNullable<ProxyOptions["fetch"]>,
  url: string,
  assignment: Assignment,
  body: Readonly<Record<string, unknown>>,
): Promise<PingResult> {
  try {
    const response = await execute(url, {
      method: "POST",
      headers: {
        "X-Arena-Assignment-ID": assignment.assignmentID,
        "X-Arena-Scope-ID": assignment.scopeID,
        [KEEP_ALIVE_HEADER]: "1",
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({ ...body, max_tokens: 1 }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) return "failed"
    return response.headers.get(KEEP_ALIVE_HEADER) === "1" ? "kept" : "unsupported"
  } catch {
    return "failed"
  }
}

export async function proxy(request: Request, registry: AssignmentRegistry, options: ProxyOptions) {
  let metadata: RequestMetadata | undefined
  let telemetry: Telemetry | undefined
  let preHeaderTransportFailure = false
  const requestState: { phase: GenerationFailurePhase; requestBytes?: number } = { phase: "prepare" }
  let endWait: ((ping?: Ping) => void) | undefined
  try {
    const { requestID, sessionID, parentSessionID } = sessionHeaders(request.headers)
    const assignment = registry.resolve(sessionID, parentSessionID)
    telemetry = assignment.telemetry ? options.telemetry : undefined
    const parsed = (await request.json()) as unknown
    const rewritten = rewriteBody(parsed, assignment)
    const kind = requestKind(request.headers.get("x-arena-generation-classification"))
    metadata = {
      assignment,
      generationID: `gen_${randomUUID().replaceAll("-", "")}`,
      requestID,
      sessionID,
      ...(parentSessionID ? { parentSessionID } : {}),
      requestedModel: assignment.modelSize === "medium" ? "medium" : contestant.id,
      enforcedReasoning: { effort: assignment.modelSize === "medium" ? "xhigh" : "high" },
      ...(request.headers.get("x-arena-generation-classification") === "compaction"
        ? { classification: "compaction" as const }
        : {}),
      ...(kind ? { requestKind: kind } : {}),
      startedAt: new Date(),
    }
    await telemetry?.start?.(metadata, rewritten)
    const contentFilter = options.contentFilter
    const blocked = async () => {
      if (kind === "generation" && contentFilter) await settleContentFilter(() => contentFilter(sessionID))
    }

    const upstream = options.upstream.replace(/\/$/, "")
    const execute = options.fetch ?? fetch
    const url = `${upstream}${upstreamPath(request)}`
    const classification = request.headers.get("x-arena-generation-classification")
    // What goes to the control plane: the body itself, or the body naming its uploaded media.
    let outgoing: Readonly<Record<string, unknown>> = rewritten
    const ping: Ping | undefined =
      classification === "generation" ? () => keepAlivePing(execute, url, assignment, outgoing) : undefined
    // A compaction ends the wait with no ping: the next call continues its summary, not this prompt.
    if (classification === "generation" || classification === "compaction") {
      endWait = options.keepAlive?.begin(sessionID, ping)
    }
    const routing = {
      "X-Arena-Assignment-ID": assignment.assignmentID,
      "X-Arena-Scope-ID": assignment.scopeID,
      "X-Arena-Generation-ID": metadata.generationID,
      "Content-Type": "application/json",
    }
    // Its own signal, so a stream whose connection died can be ended without ending the request.
    const dispatch = new AbortController()
    if (request.signal.aborted) dispatch.abort(request.signal.reason)
    else request.signal.addEventListener("abort", () => dispatch.abort(request.signal.reason), { once: true })
    const send = async () => {
      const body = outgoing === rewritten ? inlineText() : JSON.stringify(outgoing)
      const bytes = Buffer.byteLength(body)
      requestState.requestBytes = bytes
      await telemetry?.dispatched?.({
        metadata: metadata!,
        dispatchedAt: new Date(),
        requestBytes: bytes,
      })
      requestState.phase = "headers"
      return execute(url, {
        method: "POST",
        headers: {
          ...routing,
          Accept: request.headers.get("accept") || "text/event-stream, application/json",
          "X-OpenRouter-Metadata": "enabled",
          // Lets the control plane compact this step at the hidden model's level.
          ...(request.headers.get(COMPACTION_HEADER) === COMPACTION_OFFER
            ? { [COMPACTION_HEADER]: COMPACTION_OFFER }
            : {}),
        },
        body,
        signal: dispatch.signal,
      })
    }
    let inline: string | undefined
    const inlineText = () => (inline ??= JSON.stringify(rewritten))
    const fitsInline = () => Buffer.byteLength(inlineText()) <= REQUEST_BYTES_LIMIT
    // While the store is paused, a body that fits goes inline without asking it.
    const referenced =
      options.mediaByReference && referencesSupported(upstream) && !(storePaused(upstream) && fitsInline())
        ? referenceMedia(rewritten)
        : undefined
    const upload = async (media: Iterable<Media>): Promise<UploadFailure | undefined> => {
      requestState.phase = "upload"
      try {
        return await uploadMedia({
          execute,
          put: options.mediaUpload,
          upstream,
          routing: { "X-Arena-Assignment-ID": assignment.assignmentID, "X-Arena-Scope-ID": assignment.scopeID },
          media,
          signal: dispatch.signal,
          required: () => !fitsInline(),
        })
      } catch (error) {
        if (dispatch.signal.aborted) throw error
        return { thrown: error }
      }
    }
    // When an upload fails, the media goes inline if the body fits. A body that does not fit answers
    // the failure, and the engine tries the step again: its images are never left out to make it
    // fit, which would rewrite the prompt prefix on a store's bad minute. Only after a 404 is the
    // retry sized inline, because that control plane will never take references.
    const sendInline = async (failure: UploadFailure) => {
      if (fitsInline()) {
        if (failure instanceof Response) await failure.body?.cancel().catch(() => undefined)
        outgoing = rewritten
        return send()
      }
      if (failure === "unsupported") return Response.json(MEDIA_RESIZE_ERROR, { status: 503 })
      if (failure instanceof Response) return failure
      throw failure.thrown
    }
    let response: Response
    try {
      const referencing = referenced && referenced.media.size > 0 ? referenced : undefined
      const refusal = referencing ? await upload(referencing.media.values()) : undefined
      if (referencing && refusal === undefined) outgoing = referencing.body
      // Another request may have found the route missing after this one was sized for references.
      const resize =
        options.mediaByReference && !referenced && !fitsInline() && referenceMedia(rewritten).media.size > 0
      response =
        refusal !== undefined
          ? await sendInline(refusal)
          : resize
            ? Response.json(MEDIA_RESIZE_ERROR, { status: 503 })
            : await send()
      // How the control plane answered media it could not put back, while the body names references.
      const mediaAnswer = async () => {
        if (!referenced || outgoing === rewritten || (response.status !== 409 && response.status !== 503)) return {}
        const text = await response.clone().text()
        return {
          missing: response.status === 409 ? readMediaMissing(text) : undefined,
          unavailable: response.status === 503 && readMediaUnavailable(text),
        }
      }
      // The store cannot give media back for now: this request and the next ones go inline when
      // they fit, and are otherwise tried again.
      const goInline = async () => {
        await response.body?.cancel().catch(() => undefined)
        pauseReferences(upstream)
        return sendInline(Response.json(mediaUnavailableError(), { status: 503 }))
      }
      const first = await mediaAnswer()
      if (first.unavailable) response = await goInline()
      else if (first.missing) {
        await response.body?.cancel().catch(() => undefined)
        forgetUploads(upstream, first.missing)
        const again = await upload(first.missing.flatMap((digest) => referenced?.media.get(digest) ?? []))
        response = again === undefined ? await send() : await sendInline(again)
        // The store took the files again and still cannot read them back.
        const second = again === undefined ? await mediaAnswer() : {}
        if (second.missing || second.unavailable) response = await goInline()
      }
    } catch (error) {
      preHeaderTransportFailure = !request.signal.aborted && retryableTransport(error)
      throw error
    }
    await telemetry?.response?.({
      metadata,
      status: response.status,
      headers: researchHeaders(response.headers),
      receivedAt: new Date(),
    })
    requestState.phase = response.ok ? "stream" : "http"

    const headers = responseHeaders(response.headers)
    const generationID = metadata.generationID
    const type = response.headers.get("content-type") ?? ""
    if (!response.ok) {
      // Rebuild allowlisted control responses so upstream text and capability limits never escape.
      const knownStatus = [400, 401, 402, 403, 413, 503].includes(response.status)
      const body = knownStatus ? await response.text() : undefined
      let payload = { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }
      const filtered = response.status === 400 && readContentFilter(body)
      if (filtered) payload = contentFilterError()
      if (response.status === 401 && readSessionRejected(body)) payload = sessionRejectedError()
      if (response.status === 402) payload = paymentError(readPaymentError(body) ?? "arena_payment_required")
      if (response.status === 503 && readNetworkUnavailable(body)) payload = networkUnavailableError()
      if (response.status === 413 && readCompactionRequired(body))
        payload = compactionRequiredError(readCompactionOverflow(body))
      if (response.status === 403 && readSingleAgentAllowance(body)) payload = singleAgentAllowanceError()
      if (body === undefined) await response.body?.cancel().catch(() => undefined)
      if (filtered) await blocked()
      endWait?.()
      // A filtered complete response arrives as this refusal with the usage the service kept.
      telemetry?.rawChunk?.(
        metadata,
        JSON.stringify(filtered && body ? filteredResponseRecord(JSON.parse(body), generationID) : payload),
      )
      // A refused attempt is a failed generation, not a completed one. A wait for the user's network
      // or sign-in is not the provider failing, and telemetry keeps the two apart.
      const networkWait = readNetworkUnavailable(body)
      const signInWait = response.status === 401 && readSessionRejected(body)
      await telemetry?.error?.(
        metadata,
        networkWait
          ? new ArenaWaitError("network")
          : signInWait
            ? new ArenaWaitError("sign-in")
            : new Error(`Arena upstream status ${response.status}`),
        new Date(),
        {
          phase: "http",
          kind: networkWait
            ? "network_wait"
            : signInWait
              ? "sign_in_wait"
              : filtered
                ? "content_filter"
                : "http_status",
        },
      )
      headers.set("content-type", "application/json")
      return Response.json(payload, { status: response.status, headers })
    }

    if (type.includes("text/event-stream") && response.body) {
      // Only a control plane that sends heartbeats can be told apart from a model that thinks.
      const stallMs = stallDeadline(response.headers)
      const recovery: StreamRecovery | undefined =
        stallMs !== undefined
          ? {
              stallMs,
              abandon: () => dispatch.abort(new Error("Arena contestant stream stalled")),
              replay: () =>
                execute(`${upstream}${REPLAY_PATH}`, {
                  method: "POST",
                  headers: { ...routing, Accept: "text/event-stream" },
                  body: "{}",
                  signal: request.signal,
                }),
            }
          : undefined
      const body = sanitizeStream(
        response.body,
        generationID,
        metadata,
        rewritten.max_tokens,
        telemetry,
        request.signal,
        recovery,
        (complete) => endWait?.(complete ? ping : undefined),
        blocked,
      )
      return new Response(body, { status: response.status, headers })
    }

    const raw = JSON.parse(await response.text()) as unknown
    // A complete response carries the same refusal shapes a streamed chunk does; handle them alike.
    if (contentFilterRefusal(raw)) {
      await blocked()
      endWait?.()
      // The neutral error replaces the response, so the record keeps its partial answer and usage.
      telemetry?.rawChunk?.(metadata, JSON.stringify(filteredResponseRecord(raw, generationID)))
      await telemetry?.error?.(metadata, new Error(contentFilterMessage), new Date(), {
        phase: "http",
        kind: "content_filter",
      })
      headers.set("content-type", "application/json")
      return Response.json(contentFilterError(), { status: 400, headers })
    }
    const payload = sanitizePayload(raw, generationID)
    telemetry?.rawChunk?.(metadata, JSON.stringify(payload))
    await telemetry?.complete?.(metadata, new Date())
    endWait?.(ping)
    headers.set("content-type", "application/json")
    return Response.json(payload, { status: response.status, headers })
  } catch (error) {
    endWait?.()
    const phase = requestState.phase
    const headerTimedOut =
      hasReasonMessage(request.signal.reason, "Response headers timed out") ||
      hasReasonMessage(error, "Response headers timed out")
    const failure: GenerationFailure = {
      phase,
      kind: headerTimedOut
        ? "header_timeout"
        : request.signal.aborted
          ? "aborted"
          : phase === "stream"
            ? "stream_read"
            : preHeaderTransportFailure || phase === "headers" || phase === "upload"
              ? "transport"
              : "routing",
    }
    if (metadata && (phase === "headers" || phase === "upload")) {
      console.warn("[arena-proxy] Contestant request failed before response headers", {
        generationID: metadata.generationID,
        requestID: metadata.requestID,
        phase: failure.phase,
        kind: failure.kind,
        ...(requestState.requestBytes !== undefined ? { requestBytes: requestState.requestBytes } : {}),
        elapsedMs: Date.now() - metadata.startedAt.getTime(),
      })
    }
    await telemetry?.error?.(metadata, new Error("Arena contestant request could not be routed"), new Date(), failure)
    return Response.json(
      {
        error: preHeaderTransportFailure
          ? { message: "Arena contestant request failed", type: "arena_upstream_error" }
          : { message: "Arena contestant request could not be routed", type: "arena_routing_error" },
      },
      { status: preHeaderTransportFailure ? 502 : 400 },
    )
  }
}

export * as ArenaProxy from "./proxy"
