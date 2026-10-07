import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Data, Definition } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "@/provider/provider"
import type { ProviderAuth } from "@/provider/auth"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DateTime, Schema } from "effect"
import { createHash } from "node:crypto"
import { ArenaAttachments } from "./attachments"
import { ArenaRuntime } from "./runtime"
import { paymentMessage } from "@agent-duel/arena-service/request-error"

const providerID = ProviderV2.ID.make("arena")
const modelID = ModelV2.ID.make("contestant")
const errorMessage = "Arena contestant request failed"
const retryMessage = "Arena contestant is retrying"
const callIDPrefix = "call_arena_"

type ApiError = typeof SessionV1.APIError.Schema.Type
type AssistantError = NonNullable<(typeof SessionV1.Assistant.Type)["error"]>
type MessageInfo = typeof SessionV1.Info.Type
type MessagePart = typeof SessionV1.Part.Type
type SessionInfo = typeof SessionV1.SessionInfo.Type
type WithParts = typeof SessionV1.WithParts.Type
type PartIdentity = Pick<MessagePart, "id" | "sessionID" | "messageID" | "type">

const configurationKeys = new Set([
  "defaultmodel",
  "disabledproviders",
  "enabledproviders",
  "model",
  "modelid",
  "models",
  "provider",
  "providerid",
  "providers",
  "smallmodel",
])

const metadataKeys = new Set([
  "alias",
  "apiid",
  "canonicalslug",
  "cost",
  "model",
  "modelid",
  "providermetadata",
  "provider",
  "providerid",
  "providername",
  "rawrequest",
  "rawresponse",
  "requestbody",
  "responsebody",
  "responseheaders",
  "slug",
  "systemfingerprint",
  "tokens",
  "upstream",
  "usage",
])

const errorKeys = new Set([...metadataKeys, "metadata", "ref"])

function key(value: string) {
  return value.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !DateTime.isDateTime(value)
}

type LivePartOverlay = {
  readonly sessionID: string
  readonly messageID: string
  readonly type: MessagePart["type"]
  readonly hasMetadata: boolean
  readonly metadata?: unknown
  readonly callID?: string
  readonly hasStateMetadata?: boolean
  readonly stateMetadata?: unknown
}

const liveParts = new Map<string, LivePartOverlay>()
const discardedMessages = new Map<string, Set<string>>()
const claimedMessages = new Map<string, Set<string>>()

export function rememberPart(input: MessagePart) {
  if (!ArenaRuntime.enabled()) return
  const value = input as unknown as Record<string, unknown>
  const hasMetadata = "metadata" in value
  const state = input.type === "tool" ? (input.state as unknown as Record<string, unknown>) : undefined
  const hasStateMetadata = state ? "metadata" in state : false
  if (!hasMetadata && input.type !== "tool" && !hasStateMetadata) {
    liveParts.delete(input.id)
    return
  }
  liveParts.set(input.id, {
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: input.type,
    hasMetadata,
    ...(hasMetadata ? { metadata: structuredClone(value.metadata) } : {}),
    ...(input.type === "tool" ? { callID: input.callID } : {}),
    ...(hasStateMetadata ? { hasStateMetadata: true, stateMetadata: structuredClone(state?.metadata) } : {}),
  })
}

export function restorePart<T extends PartIdentity>(input: T): T {
  if (!ArenaRuntime.enabled()) return input
  const current = liveParts.get(input.id)
  if (
    !current ||
    current.sessionID !== input.sessionID ||
    current.messageID !== input.messageID ||
    current.type !== input.type
  )
    return input
  const restored = structuredClone(input) as unknown as Record<string, unknown>
  if (current.hasMetadata) restored.metadata = structuredClone(current.metadata)
  if (input.type === "tool") {
    if (current.callID) restored.callID = current.callID
    if (current.hasStateMetadata && record(restored.state)) {
      restored.state = { ...restored.state, metadata: structuredClone(current.stateMetadata) }
    }
  }
  return restored as T
}

export function forgetPart(partID: string) {
  liveParts.delete(partID)
}

export function forgetMessage(messageID: string) {
  for (const [id, item] of liveParts) if (item.messageID === messageID) liveParts.delete(id)
}

/**
 * Marks an Arena steer as discarded before its removal event is projected. The prompt loop checks
 * this marker after its asynchronous preparation work, closing the gap where it could otherwise
 * have loaded a queued message before the delete reached the session database.
 */
export function reserveDiscard(sessionID: string, messageIDs: readonly string[]) {
  const discarded = discardedMessages.get(sessionID)
  const claimed = claimedMessages.get(sessionID)
  if (messageIDs.some((messageID) => discarded?.has(messageID) || claimed?.has(messageID))) return false
  const messages = discarded ?? new Set<string>()
  for (const messageID of messageIDs) messages.add(messageID)
  discardedMessages.set(sessionID, messages)
  return true
}

export function releaseDiscard(sessionID: string, messageIDs: readonly string[]) {
  const messages = discardedMessages.get(sessionID)
  if (!messages) return
  for (const messageID of messageIDs) messages.delete(messageID)
  if (messages.size === 0) discardedMessages.delete(sessionID)
}

export function claimMessages(sessionID: string, messageIDs: readonly string[]) {
  const discarded = discardedMessages.get(sessionID)
  const claimed = claimedMessages.get(sessionID)
  if (messageIDs.some((messageID) => discarded?.has(messageID) || claimed?.has(messageID))) return false
  const messages = claimed ?? new Set<string>()
  for (const messageID of messageIDs) messages.add(messageID)
  claimedMessages.set(sessionID, messages)
  return true
}

export function releaseClaims(sessionID: string, messageIDs: readonly string[]) {
  const messages = claimedMessages.get(sessionID)
  if (!messages) return
  for (const messageID of messageIDs) messages.delete(messageID)
  if (messages.size === 0) claimedMessages.delete(sessionID)
}

export function isMessageDiscarded(sessionID: string, messageID: string) {
  return discardedMessages.get(sessionID)?.has(messageID) ?? false
}

export function clearDiscardedMessages(sessionID: string) {
  discardedMessages.delete(sessionID)
}

export function forgetSession(sessionID: string) {
  for (const [id, item] of liveParts) if (item.sessionID === sessionID) liveParts.delete(id)
  discardedMessages.delete(sessionID)
  claimedMessages.delete(sessionID)
}

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      item === undefined ? [] : ([[name, omitUndefined(item)]] as const),
    ),
  )
}

// Upstreams mint tool call IDs in their own shape — Alibaba and Z.AI use `call_<24 hex>`,
// xAI uses `call-<uuid>-<counter>`, vLLM hosts use `chatcmpl-tool-<hex>` — so the raw ID
// names the contestant to anyone who has sampled the public models once. The xAI counter
// additionally counts tool calls the voter never saw. Hashing collapses every upstream onto
// one shape while staying stable, so the streamed part, the replayed event, and the message
// refetch all agree on the ID the UI correlates by. Nothing inbound keys on callID —
// permission replies carry requestID — so rewriting it on the way out is safe.
function syntheticCallID(value: string) {
  if (value.startsWith(callIDPrefix)) return value
  return callIDPrefix + createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function callIDs(value: unknown, toolCall = false): unknown {
  if (Array.isArray(value)) return value.map((item) => callIDs(item, toolCall))
  if (!record(value)) return value
  return callIDsRecord(value, toolCall)
}

function callIDsRecord(value: Record<string, unknown>, toolCall = false): Record<string, unknown> {
  const type = typeof value.type === "string" ? key(value.type) : ""
  const call = toolCall || ["functioncall", "toolcall", "tooluse"].includes(type)
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      const normalized = key(name)
      if (
        typeof item === "string" &&
        (normalized === "callid" || normalized === "toolcallid" || (call && normalized === "id"))
      ) {
        return [name, syntheticCallID(item)]
      }
      return [name, callIDs(item, normalized === "toolcalls")]
    }),
  )
}

export function toolCallIDs(input: unknown): unknown {
  return callIDs(input)
}

function scrub(value: unknown, blocked: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, blocked))
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      blocked.has(key(name)) ? [] : [[name, scrub(item, blocked)] as const],
    ),
  )
}

function scrubRecord(value: Record<string, unknown>, blocked: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      blocked.has(key(name)) ? [] : [[name, scrub(item, blocked)] as const],
    ),
  )
}

function eventEnvelope(input: Record<string, unknown>, field: string, value: unknown) {
  return {
    ...Object.fromEntries(
      Object.entries(input).flatMap(([name, item]) => {
        if (name === field || metadataKeys.has(key(name))) return []
        return [[name, scrub(item, metadataKeys)] as const]
      }),
    ),
    [field]: value,
  }
}

function contains(value: unknown, blocked: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => contains(item, blocked))
  if (!record(value)) return false
  return Object.entries(value).some(([name, item]) => blocked.has(key(name)) || contains(item, blocked))
}

function apiError(input: ApiError): ApiError {
  return {
    name: "APIError",
    data: {
      message: paymentMessage(input.data.statusCode, input.data.responseBody) ?? errorMessage,
      isRetryable: input.data.isRetryable,
      ...(input.data.statusCode === undefined ? {} : { statusCode: input.data.statusCode }),
    },
  }
}

function assistantError(input: AssistantError): AssistantError {
  if (input.name === "ProviderAuthError") {
    return { name: input.name, data: { providerID, message: errorMessage } }
  }
  if (input.name === "UnknownError") return { name: input.name, data: { message: errorMessage } }
  if (input.name === "MessageAbortedError") {
    return { name: input.name, data: { message: "Arena contestant stopped" } }
  }
  if (input.name === "StructuredOutputError") {
    return { name: input.name, data: { message: errorMessage, retries: input.data.retries } }
  }
  if (input.name === "ContextOverflowError") return { name: input.name, data: { message: errorMessage } }
  if (input.name === "ContentFilterError") return { name: input.name, data: { message: errorMessage } }
  if (input.name === "APIError") return apiError(input)
  return input
}

function unknownError(input: unknown) {
  if (!record(input)) return input
  if (input.type === "unknown") return { type: "unknown", message: errorMessage }
  if (typeof input.name !== "string" || !record(input.data)) return scrubRecord(input, errorKeys)
  if (input.name === "APIError") {
    return {
      name: input.name,
      data: {
        message:
          paymentMessage(
            typeof input.data.statusCode === "number" ? input.data.statusCode : undefined,
            typeof input.data.responseBody === "string" ? input.data.responseBody : undefined,
          ) ?? errorMessage,
        isRetryable: input.data.isRetryable === true,
        ...(typeof input.data.statusCode === "number" ? { statusCode: input.data.statusCode } : {}),
      },
    }
  }
  return {
    name: input.name,
    data: {
      ...scrubRecord(input.data, errorKeys),
      ...(typeof input.data.message === "string" ? { message: errorMessage } : {}),
      ...(typeof input.data.providerID === "string" ? { providerID } : {}),
    },
  }
}

function eventModel(input: unknown) {
  if (!record(input)) return input
  return {
    ...scrubRecord(input, metadataKeys),
    ...(typeof input.id === "string" ? { id: modelID } : {}),
    ...(typeof input.modelID === "string" ? { modelID } : {}),
    ...(typeof input.providerID === "string" ? { providerID } : {}),
  }
}

function eventTokens(input: unknown) {
  if (!record(input)) return input
  return {
    ...(typeof input.total === "number" ? { total: 0 } : {}),
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

function providerExecution(input: unknown) {
  if (!record(input)) return input
  return { executed: input.executed === true }
}

function retryError(input: unknown) {
  if (!record(input)) return input
  return {
    message: errorMessage,
    isRetryable: input.isRetryable === true,
    ...(typeof input.statusCode === "number" ? { statusCode: input.statusCode } : {}),
  }
}

function eventProperties(type: string, input: unknown) {
  if (!record(input)) return input
  const current = type.replace(/\.\d+$/, "")
  // `session.next.tool.*` and permission requests carry callID outside the Part schema.
  const safe = callIDsRecord(scrubRecord(input, metadataKeys))
  if (["session.created", "session.updated", "session.deleted"].includes(current)) {
    return Schema.is(SessionV1.SessionInfo)(input.info) ? { ...safe, info: sessionInfo(input.info) } : safe
  }
  if (current === "message.updated") {
    return Schema.is(SessionV1.Info)(input.info) ? { ...safe, info: messageInfo(input.info) } : safe
  }
  if (current === "message.part.updated") {
    return Schema.is(SessionV1.Part)(input.part) ? { ...safe, part: part(input.part) } : safe
  }
  if (current === "session.error") return { ...safe, error: unknownError(input.error) }
  if (current === "session.status") {
    return Schema.is(SessionStatusEvent.Info)(input.status) ? { ...safe, status: status(input.status) } : safe
  }
  if (["session.next.model.switched", "session.next.step.started"].includes(current)) {
    return { ...safe, model: eventModel(input.model) }
  }
  if (current === "session.next.context.updated") return { ...safe, text: "" }
  if (current === "session.next.step.ended") {
    return {
      ...safe,
      cost: 0,
      tokens: eventTokens(input.tokens),
    }
  }
  if (["session.next.reasoning.started", "session.next.reasoning.ended"].includes(current)) {
    return safe
  }
  if (["session.next.tool.called", "session.next.tool.success", "session.next.tool.failed"].includes(current)) {
    return { ...safe, provider: providerExecution(input.provider) }
  }
  if (current === "session.next.retried") return { ...safe, error: retryError(input.error) }
  if (current === "session.next.step.failed") return { ...safe, error: unknownError(input.error) }
  return safe
}

function eventValue(input: unknown): unknown {
  if (!record(input)) return input
  if (typeof input.type === "string" && "properties" in input) {
    return eventEnvelope(input, "properties", eventProperties(input.type, input.properties))
  }
  if (input.type === "sync" && record(input.syncEvent) && typeof input.syncEvent.type === "string") {
    return eventEnvelope(
      input,
      "syncEvent",
      eventEnvelope(input.syncEvent, "data", eventProperties(input.syncEvent.type, input.syncEvent.data)),
    )
  }
  if (typeof input.type === "string" && "data" in input) {
    return eventEnvelope(input, "data", eventProperties(input.type, input.data))
  }
  if ("payload" in input) return eventEnvelope(input, "payload", eventValue(input.payload))
  return scrubRecord(input, metadataKeys)
}

export function config(input: ConfigV1.Info): typeof ConfigV1.Info.Type {
  if (!ArenaRuntime.enabled()) return input
  return Schema.decodeUnknownSync(ConfigV1.Info)(scrub(input, configurationKeys))
}

export function changesModelConfiguration(input: ConfigV1.Info) {
  return ArenaRuntime.enabled() && contains(input, configurationKeys)
}

export function providerList(input: Provider.ListResult): Provider.ListResult {
  if (!ArenaRuntime.enabled()) return input
  return { all: [], default: {}, connected: [] }
}

export function configProviders(input: Provider.ConfigProvidersResult): Provider.ConfigProvidersResult {
  if (!ArenaRuntime.enabled()) return input
  return { providers: [], default: {} }
}

export function providerAuth(input: ProviderAuth.Methods): ProviderAuth.Methods {
  if (!ArenaRuntime.enabled()) return input
  return {}
}

export function sessionInfo(input: SessionInfo): SessionInfo {
  if (!ArenaRuntime.enabled()) return input
  return {
    ...input,
    cost: undefined,
    tokens: undefined,
    share: undefined,
    metadata: input.metadata ? scrubRecord(input.metadata, metadataKeys) : undefined,
    model: input.model ? { ...input.model, id: modelID, providerID } : undefined,
  }
}

export function messageInfo(input: MessageInfo): MessageInfo {
  if (!ArenaRuntime.enabled()) return input
  if (input.role === "user") {
    return {
      ...input,
      model: { ...input.model, providerID, modelID },
      system: undefined,
    }
  }
  return {
    ...input,
    providerID,
    modelID,
    cost: 0,
    tokens: {
      ...(input.tokens.total === undefined ? {} : { total: 0 }),
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    error: input.error ? assistantError(input.error) : undefined,
  }
}

export function part(input: MessagePart): MessagePart {
  if (!ArenaRuntime.enabled()) return input
  if (input.type === "text") return { ...input, metadata: attachmentMetadata(input.metadata) }
  if (input.type === "reasoning") return { ...input, metadata: undefined }
  if (input.type === "tool") {
    const state =
      "metadata" in input.state && input.state.metadata
        ? { ...input.state, metadata: scrubRecord(input.state.metadata, metadataKeys) }
        : input.state
    return { ...input, metadata: undefined, state, callID: syntheticCallID(input.callID) }
  }
  if (input.type === "subtask" && input.model) {
    return { ...input, model: { providerID, modelID } }
  }
  if (input.type === "retry") return { ...input, error: apiError(input.error) }
  if (input.type === "step-finish") {
    return {
      ...input,
      cost: 0,
      tokens: {
        ...(input.tokens.total === undefined ? {} : { total: 0 }),
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
  }
  return input
}

/** A battle attachment's label, set by the engine and the same on both sides, is all a text part keeps. */
function attachmentMetadata(metadata: Record<string, unknown> | undefined) {
  const attachment = metadata?.[ArenaAttachments.METADATA_KEY]
  return attachment === undefined ? undefined : { [ArenaAttachments.METADATA_KEY]: attachment }
}

export function message(input: WithParts): WithParts {
  if (!ArenaRuntime.enabled()) return input
  return { info: messageInfo(input.info), parts: input.parts.map(part) }
}

export function messages(input: ReadonlyArray<WithParts>): ReadonlyArray<WithParts> {
  if (!ArenaRuntime.enabled()) return input
  return input.map(message)
}

export function status(input: SessionStatusEvent.Info): SessionStatusEvent.Info {
  if (!ArenaRuntime.enabled() || input.type !== "retry") return input
  return { ...input, message: retryMessage, action: undefined }
}

export function event(input: unknown): unknown {
  if (!ArenaRuntime.enabled()) return input
  return eventValue(input)
}

// The prompt loop reloads the user message from SQLite and sends its `system` text to the model, so
// the durable copy keeps it. It carries Arena's contestant instructions and the user's agent
// instructions, never a model identity. Live output still hides it through `messageInfo`.
function withInstructions(type: string, input: unknown, persisted: Record<string, unknown>) {
  if (type.replace(/\.\d+$/, "") !== "message.updated") return persisted
  if (!record(input) || !record(input.info) || !record(persisted.info)) return persisted
  if (input.info.role !== "user" || typeof input.info.system !== "string") return persisted
  return { ...persisted, info: { ...persisted.info, system: input.info.system } }
}

export function persistedEventData<D extends Definition>(definition: D, input: Data<D>): Data<D> {
  if (!ArenaRuntime.enabled()) return input
  const envelope = eventValue({ type: definition.type, properties: input })
  if (!record(envelope) || !record(envelope.properties)) {
    throw new Error(`Arena privacy produced an invalid ${definition.type} event envelope`)
  }
  const sanitized = omitUndefined(withInstructions(definition.type, input, envelope.properties))
  const encoded = Schema.encodeUnknownSync(definition.data)(sanitized)
  return Schema.decodeUnknownSync(definition.data)(encoded) as Data<D>
}

export * as ArenaPrivacy from "./privacy"
