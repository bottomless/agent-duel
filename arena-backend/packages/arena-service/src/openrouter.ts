import { randomUUID } from "crypto"
import { recordAssignmentGenerationMetrics, reserveRoutingAssignment } from "./assignments"
import { authorize, type ArenaContext } from "./context"
import type { GenerationMetrics, UsageTotals } from "./metrics"
import { classifyPaymentError, retryableStreamError } from "./request-error"

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

function metricsCollector(generationID: string, startedAt: number) {
  let usagePayload: unknown
  let finished: string | undefined
  return {
    observe(value: unknown) {
      if (record(value) && (value.usage !== undefined || (record(value.data) && value.data.usage !== undefined))) {
        usagePayload = value
      }
      finished = finishReason(value) ?? finished
    },
    value(): GenerationMetrics | undefined {
      const measured = usage(usagePayload, Math.max(0, Date.now() - startedAt))
      if (!measured && !finished) return undefined
      return {
        generationID,
        ...(measured ? { usage: measured } : {}),
        ...(finished ? { finishReason: finished } : {}),
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
  return sanitized
}

function sanitizeLine(line: string, generationID: string, observe?: (value: unknown) => void) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw || raw === "[DONE]") return line
  try {
    const value = JSON.parse(raw) as unknown
    observe?.(value)
    return `data: ${JSON.stringify(sanitizePayload(value, generationID, true))}`
  } catch {
    return `data: ${JSON.stringify({
      error: { message: "Arena contestant stream failed", type: "arena_stream_error" },
    })}`
  }
}

function sanitizeStream(
  stream: ReadableStream<Uint8Array>,
  generationID: string,
  startedAt: number,
  complete: (metrics: GenerationMetrics | undefined) => Promise<void>,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let cancelled = false
  const metrics = metricsCollector(generationID, startedAt)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (cancelled) return
        if (next.done) {
          pending += decoder.decode()
          if (pending) controller.enqueue(encoder.encode(sanitizeLine(pending, generationID, metrics.observe)))
          await complete(metrics.value())
          controller.close()
          return
        }
        pending += decoder.decode(next.value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines)
          controller.enqueue(encoder.encode(`${sanitizeLine(line, generationID, metrics.observe)}\n`))
      } catch {
        if (cancelled) return
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: { message: "Arena contestant request failed", type: "arena_retryable_stream_error" },
            })}\n\n`,
          ),
        )
        controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
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

async function sanitizeAssignedResponse(
  response: Response,
  generationID: string,
  startedAt: number,
  complete: (metrics: GenerationMetrics | undefined) => Promise<void>,
) {
  const headers = assignedHeaders(response.headers)
  if (!response.ok) {
    if (response.status === 402) {
      const payload: unknown = await response.json().catch(() => null)
      return Response.json(classifyPaymentError(payload), { status: 402, headers })
    }
    return Response.json(
      { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
      { status: response.status, headers },
    )
  }
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
    return new Response(sanitizeStream(response.body, generationID, startedAt, complete), {
      status: response.status,
      headers,
    })
  }
  const raw = await response.json()
  const metrics = metricsCollector(generationID, startedAt)
  metrics.observe(raw)
  await complete(metrics.value())
  const payload = sanitizePayload(raw, generationID)
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
    if (input.model !== "contestant") {
      return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
    }
    const db = await context.db()
    const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
    if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
    const requestedGenerationID = request.headers.get("x-arena-generation-id")?.trim()
    if (requestedGenerationID && !/^gen_[0-9a-f]{32}$/i.test(requestedGenerationID)) {
      return Response.json({ error: { message: "Arena generation ID is invalid" } }, { status: 400 })
    }
    const generationID = requestedGenerationID || `gen_${randomUUID().replaceAll("-", "")}`
    const startedAt = Date.now()
    body = new TextEncoder().encode(
      JSON.stringify({
        ...input,
        model: routeAssignment.model.slug,
        reasoning: { effort: "high" },
        provider: routeAssignment.model.routing,
        stream_options: record(input.stream_options)
          ? { ...input.stream_options, include_usage: true }
          : { include_usage: true },
      }),
    ).buffer
    const response = await context.fetch(upstream, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    })
    return sanitizeAssignedResponse(response, generationID, startedAt, async (metrics) => {
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
    })
  } catch {
    console.error("[arena-service] OpenRouter proxy failed")
    return Response.json({ error: { message: "OpenRouter request failed" } }, { status: 502 })
  }
}
