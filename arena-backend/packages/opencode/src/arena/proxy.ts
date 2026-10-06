import { randomUUID } from "crypto"
import { contestant } from "./model-profile"
import type { GenerationMetrics } from "./records"
import { paymentError, readPaymentError, retryableStreamError } from "@agent-duel/arena-service/request-error"

export type Assignment = {
  readonly runID: string
  readonly rootSessionID: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly telemetry: boolean
}

export type RequestMetadata = {
  readonly assignment: Assignment
  readonly generationID: string
  readonly requestID: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly requestedModel: string
  readonly enforcedReasoning: { readonly effort: "high" }
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

export function rewriteBody(body: unknown, assignment: Assignment) {
  if (!record(body)) throw new Error("Arena proxy request body must be an object")
  if (body.model !== contestant.id) {
    throw new Error("Arena proxy request used an unexpected contestant transport model")
  }
  const { provider: _provider, ...safe } = body
  return {
    ...safe,
    model: contestant.id,
    reasoning: { effort: "high" },
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

function sanitizeLine(line: string, generationID: string) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw || raw === "[DONE]") return line
  try {
    return `data: ${JSON.stringify(sanitizePayload(JSON.parse(raw), generationID, true))}`
  } catch {
    return (
      "data: " + JSON.stringify({ error: { message: "Arena contestant stream failed", type: "arena_stream_error" } })
    )
  }
}

function sanitizeStream(
  stream: ReadableStream<Uint8Array>,
  generationID: string,
  metadata: RequestMetadata,
  telemetry?: Telemetry,
  signal?: AbortSignal,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let settled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let reading = false
      try {
        reading = true
        const next = await reader.read()
        reading = false
        if (settled) return
        if (next.done) {
          const tail = decoder.decode()
          pending += tail
          if (pending) {
            const line = sanitizeLine(pending, generationID)
            telemetry?.rawChunk?.(metadata, line)
            controller.enqueue(encoder.encode(line))
          }
          await telemetry?.complete?.(metadata, new Date())
          settled = true
          controller.close()
          return
        }
        const chunk = next.value
        const raw = decoder.decode(chunk, { stream: true })
        pending += raw
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
          const sanitized = `${sanitizeLine(line, generationID)}\n`
          telemetry?.rawChunk?.(metadata, sanitized)
          controller.enqueue(encoder.encode(sanitized))
        }
      } catch {
        if (settled) return
        settled = true
        try {
          await telemetry?.error?.(metadata, new Error("Arena contestant stream failed"), new Date())
        } catch {
          controller.error(new Error("Arena telemetry persistence failed"))
          return
        }
        if (reading && !signal?.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(retryableStreamPayload())}\n\n`))
          controller.close()
          return
        }
        controller.error(new Error("Arena contestant stream failed"))
      }
    },
    async cancel(reason) {
      if (settled) return
      settled = true
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
      requestedModel: contestant.id,
      enforcedReasoning: { effort: "high" },
      ...(request.headers.get("x-arena-generation-classification") === "compaction"
        ? { classification: "compaction" as const }
        : {}),
      startedAt: new Date(),
    }
    await telemetry?.start?.(metadata, rewritten)

    const upstream = options.upstream.replace(/\/$/, "")
    const execute = options.fetch ?? fetch
    const responsePromise = execute(`${upstream}${upstreamPath(request)}`, {
      method: "POST",
      headers: {
        "X-Arena-Assignment-ID": assignment.assignmentID,
        "X-Arena-Scope-ID": assignment.scopeID,
        "X-Arena-Generation-ID": metadata.generationID,
        "Content-Type": "application/json",
        Accept: request.headers.get("accept") || "text/event-stream, application/json",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(rewritten),
      signal: request.signal,
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
      const payload =
        response.status === 402
          ? paymentError(readPaymentError(await response.text()) ?? "arena_payment_required")
          : { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }
      if (response.status !== 402) await response.body?.cancel().catch(() => undefined)
      telemetry?.rawChunk?.(metadata, JSON.stringify(payload))
      await telemetry?.complete?.(metadata, new Date())
      headers.set("content-type", "application/json")
      return Response.json(payload, { status: response.status, headers })
    }

    if (type.includes("text/event-stream") && response.body) {
      const body = sanitizeStream(response.body, generationID, metadata, telemetry, request.signal)
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
