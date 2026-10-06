import { hasActiveComparisonScope } from "./assignments"
import { authorize, type ArenaContext } from "./context"
import { comparisonModel } from "./utility-model"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validInput(value: unknown) {
  if (!record(value) || typeof value.scopeID !== "string" || !value.scopeID.trim()) return undefined
  if (!Array.isArray(value.messages) || value.messages.length !== 1) return undefined
  const message = value.messages[0]
  if (!record(message) || message.role !== "user" || typeof message.content !== "string") return undefined
  if (value.temperature !== 0) return undefined
  if (Object.keys(value).some((key) => !["scopeID", "messages", "temperature"].includes(key))) return undefined
  return { scopeID: value.scopeID.trim(), message: { role: "user", content: message.content } as const }
}

function responseHeaders(source: Headers) {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

export async function handleComparisonRequest(request: Request, context: ArenaContext) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
  const caller = await authorize(request, context, (message, status) => Response.json({ error: message }, { status }))
  if (caller instanceof Response) return caller
  const apiKey = context.openRouterApiKey
  if (!apiKey) return Response.json({ error: "Arena comparison is unavailable" }, { status: 503 })

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return Response.json({ error: "Arena comparison request is invalid" }, { status: 400 })
  }
  const input = validInput(parsed)
  if (!input) return Response.json({ error: "Arena comparison request is invalid" }, { status: 400 })
  let active: boolean
  try {
    active = await hasActiveComparisonScope(await context.db(), caller.id, input.scopeID)
  } catch (error) {
    console.error("[arena-service] Arena comparison scope could not be read", error)
    return Response.json({ error: "Arena comparison is unavailable" }, { status: 503 })
  }
  if (!active) {
    return Response.json({ error: "Arena comparison scope is invalid" }, { status: 403 })
  }

  try {
    const response = await context.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: request.headers.get("accept") || "application/json",
        "Content-Type": "application/json",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify({
        model: comparisonModel.id,
        messages: [input.message],
        temperature: 0,
        reasoning: comparisonModel.reasoning,
        provider: comparisonModel.routing,
      }),
      signal: request.signal,
    })
    return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers) })
  } catch {
    console.error("[arena-service] Arena comparison failed")
    return Response.json({ error: "Arena comparison failed" }, { status: 502 })
  }
}
