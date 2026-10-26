import { createHash } from "node:crypto"
import { paymentMessage } from "@agent-duel/arena-service/request-error"
import { REDACTED_THINKING } from "@agent-duel/arena-service/reasoning"
import { ARENA_OFFLINE_MESSAGE } from "@/session/retry"

const OPAQUE_PROVIDER = "arena"
const OPAQUE_MODEL = "contestant"
const CATALOG_KEYS = new Set(["models", "providers", "catalog", "modelcatalog", "providercatalog"])
const PRIVATE_KEYS = new Set([
  "providerstate",
  "providerresultstate",
  "rawfinish",
  "rawproviderstate",
  "reasoningdetails",
  "identity",
  "requestmetadata",
  "replaymetadata",
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keyName(key: string) {
  return key.replace(/[-_]/g, "").toLowerCase()
}

function opaqueCallID(value: unknown) {
  const source = typeof value === "string" ? value : JSON.stringify(value)
  return `call_arena_${createHash("sha256").update(source).digest("hex").slice(0, 20)}`
}

function opaqueModelID(value: unknown) {
  // The Arena router uses two deliberately opaque model classes. Keep that
  // distinction so the normal-turn size survives a history round-trip.
  return value === "medium" ? "medium" : OPAQUE_MODEL
}

function safeError(value: unknown) {
  const text =
    typeof value === "string" ? value : record(value) && typeof value.message === "string" ? value.message : ""
  const data = record(value) && record(value.data) ? value.data : undefined
  const statusCode = data && typeof data.statusCode === "number" ? data.statusCode : undefined
  const responseBody = data && typeof data.responseBody === "string" ? data.responseBody : undefined
  const message =
    statusCode === 402
      ? (paymentMessage(statusCode, responseBody) ?? "The agent could not complete this run.")
      : (() => {
          const lower = text.toLowerCase()
          if (lower.includes("offline") || lower.includes("network") || lower.includes("connection refused")) {
            return ARENA_OFFLINE_MESSAGE
          }
          if (
            lower.includes("payment") ||
            lower.includes("billing") ||
            lower.includes("credit") ||
            lower.includes("quota")
          ) {
            return paymentMessage(402, undefined) ?? "The agent could not complete this run."
          }
          return "The agent could not complete this run."
        })()
  if (record(value)) {
    const output: Record<string, unknown> = {}
    if (typeof value.name === "string") output.name = value.name
    if (typeof value.type === "string") output.type = value.type
    output.message = message
    if (record(value.data)) {
      const data: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value.data)) {
        const normalized = keyName(key)
        if (
          normalized === "responsebody" ||
          normalized === "responseheaders" ||
          normalized === "metadata" ||
          normalized.includes("provider") ||
          normalized.includes("identity") ||
          PRIVATE_KEYS.has(normalized)
        ) {
          continue
        }
        data[key] = normalized === "message" ? message : item
      }
      data.message = message
      output.data = data
    }
    return output
  }
  return message
}

function zeroNumbers(value: unknown): unknown {
  if (typeof value === "number") return 0
  if (Array.isArray(value)) return value.map(zeroNumbers)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, zeroNumbers(item)]))
}

function sanitizeModel(value: unknown): unknown {
  if (!record(value)) return { id: OPAQUE_MODEL, providerID: OPAQUE_PROVIDER }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = keyName(key)
    if (normalized === "id" || normalized === "modelid" || normalized === "model") output[key] = opaqueModelID(item)
    else if (normalized === "providerid" || normalized === "provider") output[key] = OPAQUE_PROVIDER
    else if (normalized === "name") output[key] = "Arena model"
    else if (normalized === "family") output[key] = "arena"
    else if (normalized === "package") output[key] = ""
    else if (normalized === "canonical") output[key] = OPAQUE_PROVIDER
    else if (!PRIVATE_KEYS.has(normalized) && !CATALOG_KEYS.has(normalized)) output[key] = sanitize(item, key)
  }
  if (!("id" in output) && !("modelID" in output) && !("modelId" in output)) output.id = OPAQUE_MODEL
  if (!("providerID" in output) && !("providerId" in output)) output.providerID = OPAQUE_PROVIDER
  return output
}

function isModelInfo(value: Record<string, unknown>) {
  return "modelID" in value || "capabilities" in value || "variants" in value
}

function isProviderInfo(value: Record<string, unknown>) {
  return "activation" in value && "package" in value
}

function sanitizeProvider(value: Record<string, unknown>) {
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = keyName(key)
    if (normalized === "id" || normalized === "canonical" || normalized === "providerid") output[key] = OPAQUE_PROVIDER
    else if (normalized === "name") output[key] = "Arena"
    else if (normalized === "package") output[key] = ""
    else if (normalized === "integrationid") continue
    else if (normalized === "settings" || normalized === "headers" || normalized === "body") continue
    else if (!PRIVATE_KEYS.has(normalized) && !CATALOG_KEYS.has(normalized)) output[key] = sanitize(item, key)
  }
  if (!("id" in output)) output.id = OPAQUE_PROVIDER
  if (!("name" in output)) output.name = "Arena"
  if (!("package" in output)) output.package = ""
  return output
}

function isToolState(value: Record<string, unknown>) {
  return (
    typeof value.status === "string" && ["streaming", "pending", "running", "completed", "error"].includes(value.status)
  )
}

function sanitize(value: unknown, parentKey = "", inTool = false): unknown {
  if (typeof value === "string") {
    return keyName(parentKey) === "reasoning" || keyName(parentKey) === "thinking" ? REDACTED_THINKING : value
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map((item) => sanitize(item, parentKey, inTool))

  const object = value as Record<string, unknown>
  if (isModelInfo(object)) return sanitizeModel(object)
  if (isProviderInfo(object)) return sanitizeProvider(object)
  const output: Record<string, unknown> = {}
  const objectType = typeof object.type === "string" ? keyName(object.type) : ""
  const nativeReasoningDelta = objectType === "session.reasoning.delta"
  const nativeReasoningEnded = objectType === "session.reasoning.ended"
  const nativeSessionError = objectType === "session.error"
  for (const [key, item] of Object.entries(object)) {
    const normalized = keyName(key)
    if (CATALOG_KEYS.has(normalized)) continue
    if (PRIVATE_KEYS.has(normalized)) continue
    if (normalized === "cost" || normalized === "tokens" || normalized === "usage") {
      output[key] = zeroNumbers(item)
      continue
    }
    if (normalized === "reasoning" || normalized === "thinking") {
      output[key] = typeof item === "string" ? REDACTED_THINKING : sanitize(item, key, false)
      continue
    }
    if (normalized === "text" && objectType === "reasoning") {
      output[key] = REDACTED_THINKING
      continue
    }
    if (normalized === "error" || normalized === "providererror" || normalized === "rawerror") {
      output[key] = safeError(item)
      continue
    }
    if (normalized === "data" && record(item) && (nativeReasoningDelta || nativeReasoningEnded || nativeSessionError)) {
      const data = sanitize(item, key, inTool) as Record<string, unknown>
      if (nativeReasoningDelta && "delta" in item) data.delta = REDACTED_THINKING
      if (nativeReasoningEnded && "text" in item) data.text = REDACTED_THINKING
      if (nativeSessionError && "error" in item) data.error = safeError(item.error)
      output[key] = data
      continue
    }
    if ((normalized === "model" || normalized === "modelref") && record(item)) {
      output[key] = sanitizeModel(item)
      continue
    }
    if (normalized === "modelid") {
      output[key] = opaqueModelID(item)
      continue
    }
    if (normalized === "providerid" || normalized === "provider") {
      output[key] = OPAQUE_PROVIDER
      continue
    }
    if (normalized === "callid" || normalized === "toolcallid") {
      output[key] = opaqueCallID(item)
      continue
    }
    if (normalized === "id" && (inTool || objectType === "tool")) {
      output[key] = opaqueCallID(item)
      continue
    }
    if (normalized === "state") {
      if (!record(item) || !isToolState(item)) continue
      output[key] = sanitize(item, key, true)
      continue
    }
    if (normalized === "metadata" && record(item)) {
      const metadata: Record<string, unknown> = {}
      for (const [metadataKey, metadataValue] of Object.entries(item)) {
        const metadataName = keyName(metadataKey)
        if (PRIVATE_KEYS.has(metadataName) || metadataName.includes("provider") || metadataName.includes("identity"))
          continue
        metadata[metadataKey] = sanitize(metadataValue, metadataKey, inTool)
      }
      output[key] = metadata
      continue
    }
    output[key] = sanitize(item, key, inTool || normalized === "tool")
  }
  return output
}

/** Sanitize native OpenCode v2 history and event envelopes at the Arena client boundary. */
export function sanitizeV2<T>(value: T): T {
  return sanitize(value) as T
}

export { OPAQUE_MODEL, OPAQUE_PROVIDER }
