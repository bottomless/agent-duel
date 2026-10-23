import type { ModelLimits } from "./pool"

/** Provider neutral allowance for each image or file part after its encoded bytes are removed. */
export const MEDIA_TOKEN_ALLOWANCE = 4_000

export type RequestEndpoint = "chat" | "responses"

const MEDIA_TYPES = new Set([
  "file",
  "image",
  "image_url",
  "input_file",
  "input_image",
  "file-data",
  "file-url",
  "image-data",
  "image-url",
  "media",
])

const MEDIA_FIELDS = new Set(["data", "file_data", "file_url", "image", "image_url", "url"])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stripMediaBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMediaBytes)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !MEDIA_FIELDS.has(key))
      .map(([key, item]) => [key, stripMediaBytes(item)]),
  )
}

function stripMediaPart(value: unknown, state: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => stripMediaPart(item, state))
  if (!record(value)) return value
  const type = typeof value.type === "string" ? value.type : undefined
  if (type === undefined || !MEDIA_TYPES.has(type)) return value
  state.count++
  return stripMediaBytes(value)
}

function stripContent(value: unknown, state: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => stripContent(item, state))
  if (!record(value)) return value
  const type = typeof value.type === "string" ? value.type : undefined
  if (type !== undefined && MEDIA_TYPES.has(type)) return stripMediaPart(value, state)

  // Tool results can carry media in nested content/output values. Only these known content
  // containers are traversed; tool definitions and JSON schemas stay byte-for-byte represented.
  if (type === "tool-result" || type === "tool_result" || type === "function_call_output") {
    const result = { ...value }
    if ("content" in result) result.content = stripContent(result.content, state)
    if (Array.isArray(result.output)) result.output = stripContent(result.output, state)
    if (record(result.output) && "content" in result.output) {
      result.output = { ...result.output, content: stripContent(result.output.content, state) }
    }
    if (record(result.output) && Array.isArray(result.output.value)) {
      result.output = { ...result.output, value: stripContent(result.output.value, state) }
    }
    return result
  }
  return value
}

function stripRequestMedia(value: unknown, state: { count: number }): unknown {
  if (!record(value)) return value
  const result = { ...value }
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((message) => {
      if (!record(message) || !("content" in message)) return message
      return { ...message, content: stripContent(message.content, state) }
    })
  }
  if (Array.isArray(result.input)) {
    result.input = result.input.map((item) => {
      if (record(item) && (item.type === "message" || typeof item.role === "string")) {
        return { ...item, content: stripContent(item.content, state) }
      }
      return stripContent(item, state)
    })
  }
  return result
}

/** Estimates the full outgoing request while excluding encoded media bytes. */
export function estimateRequest(input: unknown) {
  const state = { count: 0 }
  const withoutMedia = stripRequestMedia(input, state)
  return Math.max(0, Math.round(JSON.stringify(withoutMedia).length / 4)) + state.count * MEDIA_TOKEN_ALLOWANCE
}

function numeric(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function outputKeys(endpoint: RequestEndpoint) {
  return endpoint === "responses" ? ["max_output_tokens"] : ["max_completion_tokens", "max_tokens"]
}

/**
 * Applies the private output cap and returns a cloned body plus its complete input/output estimate.
 * A missing output field is made explicit so the provider cannot choose a larger default.
 */
export function prepareRequest(input: Record<string, unknown>, endpoint: RequestEndpoint, limits: ModelLimits) {
  const keys = outputKeys(endpoint)
  const requested = keys.map((key) => numeric(input[key])).filter((value): value is number => value !== undefined)
  const output = Math.min(limits.output, requested.length > 0 ? Math.max(...requested) : limits.output)
  const request = { ...input }
  if (endpoint === "responses") {
    request.max_output_tokens = output
  } else {
    const hasCompletion = "max_completion_tokens" in request
    const hasLegacy = "max_tokens" in request
    if (hasCompletion) request.max_completion_tokens = output
    if (hasLegacy) request.max_tokens = output
    if (!hasCompletion && !hasLegacy) request.max_tokens = output
  }
  return {
    request,
    output,
    estimate: estimateRequest(request) + output,
  }
}
