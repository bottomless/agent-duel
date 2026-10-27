import { createHash, createHmac, randomUUID } from "crypto"
import { recordAssignmentGenerationMetrics, reserveRoutingAssignment, type SingleAgentModelSize } from "./assignments"
import { authorize, type ArenaContext, type Fetch } from "./context"
import { KEEP_ALIVE_HEADER, keepAliveAnswer, keepsCacheWarm } from "./keep-alive"
import type { StoredGenerationMetrics, UsageTotals } from "./metrics"
import { classifyPaymentError, networkUnavailableError, retryableStreamError } from "./request-error"
import type { ModelPool, ModelProfile } from "./pool"
import { createReasoningRedactor } from "./reasoning"
import {
  HEARTBEAT_HEADER,
  HEARTBEAT_LINE,
  HEARTBEAT_MS,
  REPLAY_PATH,
  replayRecorder,
  replayResponse,
  type ReplayRecorder,
} from "./stream-recovery"

type ReasoningRedactor = ReturnType<typeof createReasoningRedactor>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeUsage(value: unknown) {
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.toLowerCase().includes("cost")))
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usage(value: unknown, latencyMs: number): UsageTotals | undefined {
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
  const costDetails = record(source.cost_details) ? source.cost_details : undefined
  const upstreamInferenceCost = nonNegativeNumber(costDetails?.upstream_inference_cost)
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: number(completionDetails?.reasoning_tokens ?? source.reasoning_tokens),
    totalTokens: number(source.total_tokens) || promptTokens + completionTokens,
    cacheReadTokens: number(promptDetails?.cached_tokens ?? cacheDetails?.read ?? source.cache_read_tokens),
    cacheWriteTokens: number(promptDetails?.cache_write_tokens ?? cacheDetails?.write ?? source.cache_write_tokens),
    cost: number(source.cost ?? value.cost),
    ...(upstreamInferenceCost === undefined ? {} : { upstreamInferenceCost }),
    attempts: 1,
    latencyMs,
  }
}

function finishReason(value: unknown) {
  if (!record(value)) return undefined
  if (typeof value.status === "string" && ["completed", "incomplete", "failed"].includes(value.status)) {
    return value.status
  }
  if (!Array.isArray(value.choices)) return undefined
  for (const choice of value.choices) {
    if (!record(choice)) continue
    const reason = choice.finish_reason ?? choice.finishReason
    if (typeof reason === "string" && reason.trim()) return reason
  }
  return undefined
}

// A `/responses` stream nests the response, with its usage, status and provider, in each event.
function generation(value: unknown) {
  return record(value) && record(value.response) ? value.response : value
}

function metricsCollector(generationID: string, startedAt: number) {
  let usagePayload: unknown
  let finished: string | undefined
  let provider: string | undefined
  return {
    observe(event: unknown) {
      const value = generation(event)
      if (record(value) && (value.usage !== undefined || (record(value.data) && value.data.usage !== undefined))) {
        usagePayload = value
      }
      finished = finishReason(value) ?? finished
      if (record(value) && typeof value.provider === "string" && value.provider) provider = value.provider
    },
    value(): StoredGenerationMetrics | undefined {
      const measured = usage(usagePayload, Math.max(0, Date.now() - startedAt))
      if (!measured && !finished) return undefined
      return {
        generationID,
        ...(measured ? { usage: measured } : {}),
        ...(finished ? { finishReason: finished } : {}),
        ...(provider ? { provider } : {}),
      }
    },
  }
}

function sanitizePayload(value: unknown, generationID: string, stream = false): unknown {
  if (!record(value)) return value
  if (value.error !== undefined) {
    return {
      error: {
        message: "Arena contestant request failed",
        type: stream && retryableStreamError(value.error) ? "arena_retryable_stream_error" : "arena_upstream_error",
      },
    }
  }
  const sanitized = { ...value }
  if ("id" in sanitized) sanitized.id = generationID
  for (const key of [
    "model",
    "model_id",
    "provider",
    "provider_name",
    "openrouter_metadata",
    "system_fingerprint",
    "cost",
    "cost_details",
  ]) {
    delete sanitized[key]
  }
  if ("usage" in sanitized) sanitized.usage = sanitizeUsage(sanitized.usage)
  if (record(sanitized.data)) sanitized.data = sanitizePayload(sanitized.data, generationID)
  if (record(sanitized.response)) sanitized.response = sanitizePayload(sanitized.response, generationID)
  return sanitized
}

function sanitizeLine(
  line: string,
  generationID: string,
  reasoning: ReasoningRedactor,
  observe?: (value: unknown) => void,
) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw) return line
  try {
    if (raw === "[DONE]") {
      const tail = reasoning.flush()
      reasoning.clear()
      return tail ? `data: ${JSON.stringify({ id: generationID, ...tail })}\n\n${line}` : line
    }
    const value = JSON.parse(raw) as unknown
    observe?.(value)
    return `data: ${JSON.stringify(reasoning.redact(sanitizePayload(value, generationID, true), true))}`
  } catch {
    reasoning.clear()
    return `data: ${JSON.stringify({
      error: { message: "Arena contestant stream failed", type: "arena_stream_error" },
    })}`
  }
}

function sanitizeStream(
  stream: ReadableStream<Uint8Array>,
  generationID: string,
  reasoning: ReasoningRedactor,
  startedAt: number,
  complete: (metrics: StoredGenerationMetrics | undefined) => Promise<void>,
  recovery?: ReplayRecorder,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastWrite = Date.now()
  const metrics = metricsCollector(generationID, startedAt)
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }
  // Whether the client has data lines of an event whose closing blank line it has not received. An
  // error written into that event becomes one more data line, the client cannot parse the joined
  // data, and a retryable failure turns into a final one.
  let open = false
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    controller.enqueue(encoder.encode(text))
    recovery?.record(text)
    lastWrite = Date.now()
  }
  const writeLine = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    if (open && line.startsWith('data: {"error":')) write(controller, "\n")
    write(controller, `${line}\n`)
    if (line.startsWith("data:")) open = true
    else if (line === "") open = false
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!recovery) return
      // A model that thinks without output still sends comments, so a quiet connection is a dead one.
      heartbeat = setInterval(() => {
        if (Date.now() - lastWrite < HEARTBEAT_MS) return
        try {
          controller.enqueue(encoder.encode(`${HEARTBEAT_LINE}\n`))
          lastWrite = Date.now()
        } catch {
          stopHeartbeat()
        }
      }, HEARTBEAT_MS / 4)
    },
    async pull(controller) {
      try {
        // A pull that emits nothing may never be called again. Keep reading a fragmented SSE line.
        while (true) {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) {
            pending += decoder.decode()
            if (pending) writeLine(controller, sanitizeLine(pending, generationID, reasoning, metrics.observe))
            if (open) writeLine(controller, "")
            const tail = reasoning.flush()
            if (tail) write(controller, `\n\ndata: ${JSON.stringify({ id: generationID, ...tail })}\n\n`)
            reasoning.clear()
            stopHeartbeat()
            // Recorded before the close: a hosted function may stop once its response ends.
            await Promise.all([complete(metrics.value()), recovery?.complete()])
            controller.close()
            return
          }
          pending += decoder.decode(next.value, { stream: true })
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          if (!lines.length) continue
          for (const line of lines) writeLine(controller, sanitizeLine(line, generationID, reasoning, metrics.observe))
          return
        }
      } catch {
        reasoning.clear()
        stopHeartbeat()
        if (cancelled) return
        await recovery?.fail()
        controller.enqueue(
          encoder.encode(
            `${open ? "\n" : ""}data: ${JSON.stringify({
              error: { message: "Arena contestant request failed", type: "arena_retryable_stream_error" },
            })}\n\n`,
          ),
        )
        controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
      stopHeartbeat()
      reasoning.clear()
      void recovery?.fail()
      return reader.cancel(reason)
    },
  })
}

function assignedHeaders(source: Headers) {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

// Anthropic caches a prompt only when the request asks, and the blinded engine cannot tell it is
// talking to Claude, so without this every contestant step pays full input price for the whole
// conversation. OpenRouter puts the breakpoint on the last cacheable block of each request. The
// engine sends no tools only for compaction summaries and titles, whose prefix no later request
// shares, so a write there would cost 25% more and never be read. A body that marks its own
// breakpoints keeps them alone: one more could exceed Anthropic's four or clash with their TTL, and
// only Claude requests would fail.
function promptCache(slug: string, input: Record<string, unknown>) {
  const tools = Array.isArray(input.tools) ? input.tools : []
  if (!slug.startsWith("anthropic/") || tools.length === 0 || input.cache_control !== undefined) return {}
  const messages = Array.isArray(input.messages) ? input.messages : []
  const marked = messages.some(
    (message) =>
      record(message) &&
      (message.cache_control !== undefined ||
        (Array.isArray(message.content) &&
          message.content.some((part) => record(part) && part.cache_control !== undefined))),
  )
  return marked ? {} : { cache_control: { type: "ephemeral" } }
}

// The engine cannot tell which model it is talking to, so any sampling it sends was chosen for no
// model in particular (the title agent asks for a temperature of 0.5). Claude and OpenAI's reasoning
// models take none of these, and under the pool's `require_parameters` OpenRouter then finds no
// endpoint, so only those draws would fail. Every contestant runs on its provider's defaults.
const samplingParameters = new Set(["temperature", "top_p", "top_k"])

function withoutSampling(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !samplingParameters.has(key)))
}

const alternateSelectors = new Set(["model_id", "models", "preset", "presets", "provider", "provider_name", "route"])

const unsupportedServerFeatures = new Set(["plugin", "plugins", "server_tools", "web_search_options"])

function invalidRequestBody(input: unknown) {
  if (!record(input)) return "Arena OpenRouter request body must be an object"
  for (const key of Object.keys(input)) {
    const normalized = key.toLowerCase()
    if (alternateSelectors.has(normalized)) return `Arena OpenRouter request field is not allowed: ${key}`
    if (unsupportedServerFeatures.has(normalized)) return `Arena OpenRouter request field is not supported: ${key}`
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) return "Arena OpenRouter tools must be an array"
    for (const tool of input.tools) {
      if (!record(tool) || tool.type !== "function") return "Arena OpenRouter server-side tools are not supported"
    }
  }
  return undefined
}

// A battle side lives for one turn, so its assignment id keys its cache and its provider. A
// single-agent chat draws a new assignment for every message over one growing conversation, and a
// key per message would send each message's first call away from the cache the last one wrote. The
// engine names that scope after the session and the message (`ensureSingleAgentRating` in
// `opencode/src/arena/service.ts`), so the key is a keyed hash of the account and the session: the
// same for the whole chat, whatever model each message draws, and naming neither.
const singleAgentScope = /^single-agent\|(\d+):/

function cacheKey(
  apiKey: string,
  userId: string,
  scopeID: string,
  assignment: { readonly assignmentID: string; readonly modelSize?: SingleAgentModelSize },
) {
  const match = assignment.modelSize === undefined ? null : singleAgentScope.exec(scopeID)
  if (!match) return assignment.assignmentID
  const sessionID = scopeID.slice(match[0].length, match[0].length + Number(match[1]))
  if (!sessionID || sessionID.length !== Number(match[1])) return assignment.assignmentID
  const key = createHash("sha256").update("arena-cache-key-v1\0").update(apiKey).digest()
  return createHmac("sha256", key).update(`${userId.length}:${userId}|${sessionID}`).digest("hex").slice(0, 32)
}

/** The fields the proxy decides for every contestant call, replacing any the engine sent. */
function assignedRouting(model: ModelProfile, modelSize: SingleAgentModelSize | undefined, key: string) {
  return {
    model: model.slug,
    reasoning:
      model.reasoningEffort === null
        ? { enabled: true }
        : { effort: model.reasoningEffort ?? (modelSize === "medium" ? "xhigh" : "high") },
    provider: model.routing,
    // Without these OpenRouter's throughput sort can move a conversation to another provider whose
    // cache is empty, and some providers miss their own cache without a key.
    session_id: key,
    prompt_cache_key: key,
  }
}

function assignmentHeaders(request: Request) {
  const assignmentHeader = request.headers.get("x-arena-assignment-id")
  const scopeHeader = request.headers.get("x-arena-scope-id")
  const assignmentID = assignmentHeader?.trim()
  const scopeID = scopeHeader?.trim()
  const hasAssignmentHeader = assignmentHeader !== null
  const hasScopeHeader = scopeHeader !== null
  if (!assignmentID || !scopeID || !hasAssignmentHeader || !hasScopeHeader) return undefined
  return { assignmentID, scopeID }
}

// Enough of an upstream error to name the cause; some provider errors quote the request.
const MAX_LOGGED_REFUSAL = 4_000

interface RefusalContext {
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly generationID: string
  readonly model: string
}

// The client only ever gets a neutral answer, so the reason OpenRouter gave is logged here, the one
// place that sees it. `scopeID` is the battle ID a feedback report carries, which finds the line.
function logRefusal(context: RefusalContext, status: number, upstream: string) {
  console.error(
    "[arena-service] OpenRouter refused a contestant request",
    JSON.stringify({ ...context, status, upstream: upstream.slice(0, MAX_LOGGED_REFUSAL) }),
  )
}

// Nobody reads a ping's one token. Whether it read the cache is what tells a ping that kept the
// entry from one that landed on another provider and wrote a new one, so that much is logged.
async function logKeepAlive(response: Response, startedAt: number) {
  const text = await response.text().catch(() => undefined)
  if (!response.ok || text === undefined) {
    console.warn("[arena-service] Keep-alive ping failed", JSON.stringify({ status: response.status }))
    return
  }
  const metrics = metricsCollector("keep-alive", startedAt)
  const values = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").flatMap((line) => {
        const raw = line.startsWith("data:") ? line.slice("data:".length).trim() : ""
        return raw && raw !== "[DONE]" ? [raw] : []
      })
    : [text]
  for (const raw of values) {
    try {
      metrics.observe(JSON.parse(raw))
    } catch {
      // A line that is not JSON carries no usage.
    }
  }
  const measured = metrics.value()
  console.info(
    "[arena-service] Keep-alive ping",
    JSON.stringify({
      provider: measured?.provider,
      promptTokens: measured?.usage?.promptTokens,
      cacheReadTokens: measured?.usage?.cacheReadTokens,
      cacheWriteTokens: measured?.usage?.cacheWriteTokens,
    }),
  )
}

async function sanitizeAssignedResponse(
  response: Response,
  refusal: RefusalContext,
  reasoning: ReasoningRedactor,
  startedAt: number,
  complete: (metrics: StoredGenerationMetrics | undefined) => Promise<void>,
  recovery?: () => ReplayRecorder | undefined,
) {
  const { generationID } = refusal
  const headers = assignedHeaders(response.headers)
  if (!response.ok) {
    const upstream = await response.text().catch(() => "")
    logRefusal(refusal, response.status, upstream)
    if (response.status === 402) {
      let payload: unknown = null
      try {
        payload = JSON.parse(upstream)
      } catch {
        payload = null
      }
      return Response.json(classifyPaymentError(payload), { status: 402, headers })
    }
    return Response.json(
      { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
      { status: response.status, headers },
    )
  }
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
    const recorder = recovery?.()
    if (recorder) headers.set(HEARTBEAT_HEADER, String(HEARTBEAT_MS))
    return new Response(sanitizeStream(response.body, generationID, reasoning, startedAt, complete, recorder), {
      status: response.status,
      headers,
    })
  }
  const raw = await response.json()
  const metrics = metricsCollector(generationID, startedAt)
  metrics.observe(raw)
  await complete(metrics.value())
  const payload = reasoning.redact(sanitizePayload(raw, generationID))
  headers.set("content-type", "application/json")
  return Response.json(payload, { status: response.status, headers })
}

export async function handleOpenRouterRequest(request: Request, context: ArenaContext) {
  const caller = await authorize(request, context, (message, status) =>
    Response.json({ error: { message } }, { status }),
  )
  if (caller instanceof Response) return caller
  const apiKey = context.openRouterApiKey
  if (!apiKey) return Response.json({ error: { message: "OpenRouter is unavailable" } }, { status: 503 })

  const url = new URL(request.url)
  const suffix = url.pathname.replace(/^\/api\/openrouter/, "")
  if (!suffix.startsWith("/api/v1/")) return Response.json({ error: { message: "Not found" } }, { status: 404 })
  const upstream = new URL(`https://openrouter.ai${suffix}`)
  const headers = new Headers()
  headers.set("Authorization", `Bearer ${apiKey}`)
  headers.set("Accept", request.headers.get("accept") || "application/json")
  const contentType = request.headers.get("content-type")
  if (contentType) headers.set("Content-Type", contentType)
  headers.set("X-OpenRouter-Metadata", "enabled")

  try {
    let body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const assignment = assignmentHeaders(request)
    if (!assignment) {
      return Response.json({ error: { message: "Arena assignment scope is invalid" } }, { status: 400 })
    }
    if (url.search) {
      return Response.json(
        { error: { message: "Arena OpenRouter query parameters are not supported" } },
        { status: 400 },
      )
    }
    const requestedGenerationID = request.headers.get("x-arena-generation-id")?.trim()
    if (requestedGenerationID && !/^gen_[0-9a-f]{32}$/i.test(requestedGenerationID)) {
      return Response.json({ error: { message: "Arena generation ID is invalid" } }, { status: 400 })
    }
    if (context.streamRecovery && request.method === "POST" && suffix === REPLAY_PATH) {
      if (!requestedGenerationID) {
        return Response.json({ error: { message: "Arena generation ID is required" } }, { status: 400 })
      }
      const db = await context.db()
      const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
      if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
      return await replayResponse(
        db,
        { userId: caller.id, ...assignment, generationID: requestedGenerationID },
        context.now,
        request.signal,
      )
    }
    if (request.method !== "POST" || !["/api/v1/chat/completions", "/api/v1/responses"].includes(suffix)) {
      return Response.json({ error: { message: "Arena assignment cannot access this route" } }, { status: 400 })
    }

    if (!body)
      return Response.json({ error: { message: "Arena OpenRouter request body is required" } }, { status: 400 })
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as unknown
    } catch {
      return Response.json({ error: { message: "Arena OpenRouter request body is invalid JSON" } }, { status: 400 })
    }
    const bodyError = invalidRequestBody(input)
    if (bodyError) return Response.json({ error: { message: bodyError } }, { status: 400 })
    if (!record(input)) {
      return Response.json({ error: { message: "Arena OpenRouter request body must be an object" } }, { status: 400 })
    }
    if (input.model !== "contestant" && input.model !== "medium") {
      return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
    }
    const db = await context.db()
    const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
    if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
    const expectedModel = routeAssignment.modelSize === "medium" ? "medium" : "contestant"
    if (input.model !== expectedModel) {
      return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
    }
    const keepAlive = request.headers.get(KEEP_ALIVE_HEADER) === "1"
    if (keepAlive && (suffix !== "/api/v1/chat/completions" || !keepsCacheWarm(routeAssignment.model.slug))) {
      return keepAliveAnswer()
    }
    const reasoning = createReasoningRedactor(apiKey, {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
    })
    const restored = reasoning.restore(input)
    const generationID = requestedGenerationID || `gen_${randomUUID().replaceAll("-", "")}`
    const startedAt = Date.now()
    body = new TextEncoder().encode(
      JSON.stringify({
        ...withoutSampling(restored),
        ...assignedRouting(
          routeAssignment.model,
          routeAssignment.modelSize,
          cacheKey(apiKey, caller.id, assignment.scopeID, routeAssignment),
        ),
        ...promptCache(routeAssignment.model.slug, input),
        stream_options: record(input.stream_options)
          ? { ...input.stream_options, include_usage: true }
          : { include_usage: true },
        // The output cap is not part of the cached prompt, so the ping reads what the call wrote.
        ...(keepAlive ? { max_tokens: 1, max_completion_tokens: undefined } : {}),
      }),
    ).buffer
    const response = await context.fetch(upstream, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    })
    if (keepAlive) {
      await logKeepAlive(response, startedAt)
      return keepAliveAnswer()
    }
    // Awaited so a body that fails to read or parse still gets the 502 below.
    const refusal = {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
      generationID,
      model: routeAssignment.model.slug,
    }
    const recordMetrics = async (metrics: StoredGenerationMetrics | undefined) => {
      if (!metrics || !requestedGenerationID) return
      try {
        await recordAssignmentGenerationMetrics(db, {
          userId: caller.id,
          scopeID: assignment.scopeID,
          assignmentID: assignment.assignmentID,
          metrics,
        })
      } catch {
        console.error("[arena-service] Arena generation metrics could not be recorded")
      }
    }
    const recovery = () =>
      context.streamRecovery && requestedGenerationID
        ? replayRecorder(db, { userId: caller.id, ...assignment, generationID: requestedGenerationID }, context.now)
        : undefined
    return await sanitizeAssignedResponse(response, refusal, reasoning, startedAt, recordMetrics, recovery)
  } catch (error) {
    if (await context.networkUnavailable?.(error)) return Response.json(networkUnavailableError(), { status: 503 })
    console.error("[arena-service] OpenRouter proxy failed")
    return Response.json({ error: { message: "OpenRouter request failed" } }, { status: 502 })
  }
}

/**
 * Sends one small tool-carrying request per profile with the fields `assignedRouting` adds. Under
 * `require_parameters` OpenRouter refuses a field a model's providers lack for that model's draws
 * only, and the refusal tells the voter which model it is. The catalog check cannot show that, so
 * run this before a pool change ships. It pays for one call per profile.
 */
export async function probeRouting(pool: ModelPool, apiKey: string, execute: Fetch = fetch) {
  for (const profile of pool) {
    const response = await execute("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...assignedRouting(profile, undefined, randomUUID()),
        messages: [{ role: "user", content: "Reply with OK." }],
        tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
        stream: false,
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `Arena contestant refused the proxy's routing fields: ${profile.displayName} (${response.status}) ${detail.slice(0, MAX_LOGGED_REFUSAL)}`,
      )
    }
  }
}
