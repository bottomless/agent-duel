import { randomUUID } from "crypto"
import { contestant } from "./model-profile"
import type { GenerationMetrics } from "./records"
import {
  networkUnavailableError,
  paymentError,
  readNetworkUnavailable,
  readPaymentError,
  retryableStreamError,
} from "@agent-duel/arena-service/request-error"
import { HEARTBEAT_HEADER, REPLAY_PATH, REPLAY_UNAVAILABLE_LINE } from "@agent-duel/arena-service/stream-recovery"

export type Assignment = {
  readonly runID: string
  readonly rootSessionID: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly telemetry: boolean
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
  readonly startedAt: Date
}

export interface Telemetry {
  readonly start?: (metadata: RequestMetadata, body: Readonly<Record<string, unknown>>) => void | Promise<void>
  readonly response?: (input: {
    readonly metadata: RequestMetadata
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly receivedAt: Date
  }) => void | Promise<void>
  readonly rawChunk?: (metadata: RequestMetadata, chunk: string) => void
  readonly complete?: (metadata: RequestMetadata, completedAt: Date) => void | Promise<void>
  readonly error?: (metadata: RequestMetadata | undefined, error: unknown, at: Date) => void | Promise<void>
  readonly reveal?: (input: {
    readonly runIDs: readonly string[]
    readonly metrics: readonly GenerationMetrics[]
  }) => void | Promise<void>
}

export type ProxyOptions = {
  /** Base of the assigned OpenRouter routes. `fetch` adds whatever credential they need. */
  readonly upstream: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly telemetry?: Telemetry
  readonly onDispatch?: (metadata: RequestMetadata) => void
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
      message: "Arena contestant stream failed",
      type: "error",
      error: { code: "server_error" },
    },
  }
}

export function sanitizePayload(value: unknown, generationID: string, stream = false): unknown {
  if (!record(value)) return value
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

function sanitizeLine(line: string, generationID: string, normalize: (value: unknown) => unknown) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw || raw === "[DONE]") return line
  try {
    return `data: ${JSON.stringify(normalize(sanitizePayload(JSON.parse(raw), generationID, true)))}`
  } catch {
    return (
      "data: " + JSON.stringify({ error: { message: "Arena contestant stream failed", type: "arena_stream_error" } })
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
) {
  const normalize = normalizeToolCutoff(maxTokens)
  let reader = stream.getReader()
  let decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const tracked = trackProgress(metadata.sessionID, generationID)
  let pending = ""
  let settled = false
  let finished = false
  // Data lines the model call has received. A replay resends the whole response, so it skips them.
  let delivered = 0
  let skip = 0
  let replayed = false
  let stallMs = recovery?.stallMs
  // Whether the model call has data lines of an event whose closing blank line it has not received.
  // An error written into that event joins its data, the SDK cannot parse it, and a retryable
  // failure ends the run instead. Every error here closes the open event first.
  let open = false
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    if (open && line.startsWith('data: {"error":')) controller.enqueue(encoder.encode("\n"))
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
    tracked.failedAt = Date.now()
    tracked.failure = failure
    try {
      await telemetry?.error?.(metadata, new Error(message), new Date())
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
              emit(controller, sanitizeLine(pending, generationID, normalize))
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
          for (const line of lines) {
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
            emit(controller, sanitizeLine(line, generationID, normalize))
            forwarded = true
          }
          if (forwarded) return
        }
      } catch {
        if (settled) return
        settled = true
        tracked.failedAt = Date.now()
        tracked.failure = reading
          ? signal?.aborted
            ? "read-aborted"
            : "read"
          : tracked.savingAt !== undefined && tracked.savedAt === undefined
            ? "save"
            : "forward"
        try {
          await telemetry?.error?.(metadata, new Error("Arena contestant stream failed"), new Date())
        } catch {
          controller.error(new Error("Arena telemetry persistence failed"))
          return
        }
        if (reading && !signal?.aborted) {
          controller.enqueue(encoder.encode(errorEvent()))
          controller.close()
          return
        }
        controller.error(new Error("Arena contestant stream failed"))
      }
    },
    async cancel(reason) {
      if (settled) return
      settled = true
      tracked.cancelledAt = Date.now()
      try {
        await reader.cancel(reason)
      } finally {
        await telemetry?.error?.(metadata, new Error("Arena contestant stream was cancelled"), new Date())
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

export async function proxy(request: Request, registry: AssignmentRegistry, options: ProxyOptions) {
  let metadata: RequestMetadata | undefined
  let telemetry: Telemetry | undefined
  let preHeaderTransportFailure = false
  try {
    const { requestID, sessionID, parentSessionID } = sessionHeaders(request.headers)
    const assignment = registry.resolve(sessionID, parentSessionID)
    telemetry = assignment.telemetry ? options.telemetry : undefined
    const parsed = (await request.json()) as unknown
    const rewritten = rewriteBody(parsed, assignment)
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
      startedAt: new Date(),
    }
    await telemetry?.start?.(metadata, rewritten)

    const upstream = options.upstream.replace(/\/$/, "")
    const execute = options.fetch ?? fetch
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
    const responsePromise = execute(`${upstream}${upstreamPath(request)}`, {
      method: "POST",
      headers: {
        ...routing,
        Accept: request.headers.get("accept") || "text/event-stream, application/json",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(rewritten),
      signal: dispatch.signal,
    })
    if (
      request.headers.get("x-arena-generation-classification") === "generation" &&
      sessionID === assignment.rootSessionID
    ) {
      options.onDispatch?.(metadata)
    }
    let response: Response
    try {
      response = await responsePromise
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

    const headers = responseHeaders(response.headers)
    const generationID = metadata.generationID
    const type = response.headers.get("content-type") ?? ""
    if (!response.ok) {
      // Only these two bodies carry a neutral code the engine acts on; every other body is dropped.
      const body = response.status === 402 || response.status === 503 ? await response.text() : undefined
      const payload =
        response.status === 402
          ? paymentError(readPaymentError(body) ?? "arena_payment_required")
          : readNetworkUnavailable(body)
            ? networkUnavailableError()
            : { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }
      if (body === undefined) await response.body?.cancel().catch(() => undefined)
      telemetry?.rawChunk?.(metadata, JSON.stringify(payload))
      await telemetry?.complete?.(metadata, new Date())
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
      )
      return new Response(body, { status: response.status, headers })
    }

    const payload = sanitizePayload(JSON.parse(await response.text()) as unknown, generationID)
    telemetry?.rawChunk?.(metadata, JSON.stringify(payload))
    await telemetry?.complete?.(metadata, new Date())
    headers.set("content-type", "application/json")
    return Response.json(payload, { status: response.status, headers })
  } catch {
    await telemetry?.error?.(metadata, new Error("Arena contestant request could not be routed"), new Date())
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
