import { Bus } from "@opencode/core/bus"
import { Session as CoreSession } from "@opencode/core/session"
import { SessionEvent } from "@opencode/schema/session-event"
import type { Event } from "@opencode/schema/event"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import * as SessionV1 from "@opencode/schema/v1/session"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { partID, project } from "./session-runtime/projection"
import { ArenaService } from "./service"
import { MessageID, SessionID } from "@/session/schema"

type NativeEvent = Event.Payload

type SessionContext = {
  readonly id: string
  readonly parentID?: string
  readonly rootID: string
  readonly directory?: string
  readonly info?: Session.Info
}

type ContentPart = Record<string, unknown> & { id: string; sessionID: string; messageID: string; type: string }

export class Service extends Context.Service<Service, { readonly running: true }>()("@agent-duel/ArenaV2Events") {}

const payload = (event: NativeEvent, type: string, properties: Record<string, unknown>, context?: SessionContext) => ({
  id: event.id,
  type,
  ...(event.durable?.seq === undefined ? {} : { seq: event.durable.seq }),
  ...(event.durable?.version === undefined ? {} : { version: event.durable.version }),
  properties: {
    ...properties,
    ...(context?.id ? { sessionID: context.id } : {}),
    ...(context?.parentID ? { parentID: context.parentID } : {}),
    ...(context?.rootID ? { rootSessionID: context.rootID } : {}),
  },
})

const eventLocation = (event: NativeEvent, context?: SessionContext) => ({
  directory: event.location?.directory ?? context?.directory,
  workspace: event.location?.workspaceID,
})

function emit(event: NativeEvent, type: string, properties: Record<string, unknown>, context?: SessionContext) {
  GlobalBus.emit("event", { ...eventLocation(event, context), payload: payload(event, type, properties, context) })
}

function sessionID(event: NativeEvent) {
  return record(event.data) && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function utf16DeltaOffset(current: string, delta: string) {
  return current.length - delta.length
}

function stringField(data: unknown, key: string) {
  return record(data) && typeof data[key] === "string" ? data[key] : undefined
}

function numberField(data: unknown, key: string) {
  return record(data) && typeof data[key] === "number" ? data[key] : undefined
}

const textFromContent = (value: unknown) => {
  if (!Array.isArray(value)) return typeof value === "string" ? value : ""
  return value
    .filter(record)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("")
}

function terminalToolPart(
  part: SessionV1.ToolPart,
  eventType: string,
  data: Record<string, unknown>,
  completed: number,
): SessionV1.ToolPart {
  const input =
    part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
      ? part.state.input
      : {}
  const start =
    part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
      ? part.state.time.start
      : completed
  const metadata = record(data.metadata) ? data.metadata : {}
  if (eventType === "session.tool.success") {
    return {
      ...part,
      state: {
        status: "completed",
        input,
        output: textFromContent(data.content),
        title: typeof metadata.title === "string" ? metadata.title : part.tool,
        metadata,
        time: { start, end: completed },
      },
    }
  }
  const error = record(data.error) ? stringField(data.error, "message") : stringField(data, "error")
  return {
    ...part,
    state: {
      status: "error",
      input,
      error: error ?? "Tool execution failed",
      ...(Object.keys(metadata).length ? { metadata } : {}),
      time: { start, end: completed },
    },
  }
}

const layer: Layer.Layer<Service, never, Bus.Service | CoreSession.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* CoreSession.Service
    const arena = Option.getOrUndefined(yield* Effect.serviceOption(ArenaService.Service))
    const contexts = new Map<string, SessionContext>()
    const messages = new Map<string, SessionMessage.Info>()
    const text = new Map<string, Map<number, ContentPart>>()
    const reasoning = new Map<string, Map<number, ContentPart>>()
    const tools = new Map<string, Map<string, ContentPart>>()
    const allocations = new Map<string, Map<string, number>>()
    const toolTimes = new Map<string, number>()
    const pendingNormalTurns = new Map<string, string>()

    const keyFor = (session: string, message: string) => `${session}\u0000${message}`

    const deleteMessage = (session: string, message: string) => {
      const key = keyFor(session, message)
      messages.delete(key)
      text.delete(key)
      reasoning.delete(key)
      tools.delete(key)
      allocations.delete(key)
      for (const id of [...toolTimes.keys()]) if (id.startsWith(`${key}\u0000`)) toolTimes.delete(id)
    }

    const deleteSession = (session: string) => {
      const prefix = `${session}\u0000`
      const keys = new Set<string>()
      for (const source of [messages, text, reasoning, tools, allocations])
        for (const key of source.keys()) if (key.startsWith(prefix)) keys.add(key)
      for (const key of keys) deleteMessage(session, key.slice(session.length + 1))
      contexts.delete(session)
      pendingNormalTurns.delete(session)
    }

    const prune = (current: string) => {
      while (contexts.size > 128) {
        const oldest = contexts.keys().next().value as string | undefined
        if (!oldest || oldest === current) break
        deleteSession(oldest)
      }
    }

    const remember = (info: Session.Info): SessionContext => {
      const previous = contexts.get(info.id)
      const parentID = typeof info.parentID === "string" ? info.parentID : previous?.parentID
      const parent = parentID ? contexts.get(parentID) : undefined
      const context = {
        id: info.id,
        parentID,
        rootID: parent?.rootID ?? info.id,
        directory: info.location?.directory,
        info,
      }
      contexts.delete(info.id)
      contexts.set(info.id, context)
      prune(info.id)
      return context
    }

    const contextFor = (event: NativeEvent) =>
      Effect.gen(function* () {
        const id = sessionID(event)
        if (!id) return undefined
        const known = contexts.get(id)
        if (known) return known
        const info = yield* sessions.get(id as CoreSession.ID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info) return undefined
        if (info.parentID && !contexts.has(info.parentID)) {
          const parent = yield* sessions
            .get(info.parentID as CoreSession.ID)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (parent) remember(parent)
        }
        return remember(info)
      })

    const messageFor = (id: string, messageID: string, refresh = false) =>
      Effect.gen(function* () {
        const key = keyFor(id, messageID)
        if (refresh) messages.delete(key)
        const known = messages.get(key)
        if (known) return known
        const message = yield* sessions.message({
          sessionID: id as Session.ID,
          messageID: messageID as SessionMessage.ID,
        })
        if (message) messages.set(key, message)
        return message
      })

    const publishMessage = (event: NativeEvent, context: SessionContext, message: SessionMessage.Info | undefined) => {
      if (!message) return
      const entries = project([message], context.id as Session.ID)
      const entry = entries[0]
      if (!entry) return
      emit(event, "message.updated", { info: entry.info }, context)
      for (const part of entry.parts) emit(event, "message.part.updated", { part }, context)
    }

    const publishPart = (event: NativeEvent, context: SessionContext, part: Record<string, unknown>) => {
      emit(event, "message.part.updated", { part }, context)
    }

    const publishDelta = (event: NativeEvent, context: SessionContext, part: ContentPart, delta: string) => {
      const currentText = typeof part.text === "string" ? part.text : ""
      emit(
        event,
        "message.part.delta",
        {
          sessionID: context.id,
          messageID: part.messageID,
          partID: part.id,
          field: "text",
          delta,
          offset: utf16DeltaOffset(currentText, delta),
        },
        context,
      )
    }

    const allocate = (session: string, message: string, kind: string) => {
      const key = keyFor(session, message)
      const byKind = allocations.get(key) ?? new Map<string, number>()
      let index = byKind.get(kind)
      if (index === undefined) {
        index = byKind.size
        byKind.set(kind, index)
        allocations.set(key, byKind)
      }
      return String(partID(message as SessionMessage.ID, index))
    }

    const handle = (event: NativeEvent) =>
      Effect.gen(function* () {
        const context = yield* contextFor(event)
        const id = sessionID(event)
        if (!id || !context) return
        const data = record(event.data) ? event.data : {}
        if (event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered") {
          const inboxID = stringField(data, "inboxID")
          if (inboxID) pendingNormalTurns.set(id, inboxID)
        }
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted"
        ) {
          const messageID = pendingNormalTurns.get(id)
          if (messageID && arena) {
            pendingNormalTurns.delete(id)
            yield* arena
              .recordNormalTurn({ sessionID: id as SessionID, messageID: messageID as MessageID })
              .pipe(Effect.catch(() => Effect.void))
          }
        }
        if (event.type === SessionEvent.Created.type) {
          emit(event, "session.created", { info: context.info ?? data, session: context.info ?? data }, context)
          return
        }
        if (event.type === SessionEvent.Deleted.type) {
          emit(event, "session.deleted", { sessionID: id }, context)
          deleteSession(id)
          return
        }
        if (event.type === "session.message.content.updated") {
          const messageID = stringField(data, "messageID")
          if (!messageID) return
          const message = yield* messageFor(id, messageID, true)
          publishMessage(event, context, message)
          return
        }
        if (
          event.type === "session.text.started" ||
          event.type === "session.text.delta" ||
          event.type === "session.text.ended"
        ) {
          const assistantMessageID = stringField(data, "assistantMessageID")
          const ordinal = numberField(data, "ordinal")
          if (!assistantMessageID || ordinal === undefined) return
          const messageKey = keyFor(id, assistantMessageID)
          const parts = text.get(messageKey) ?? new Map<number, ContentPart>()
          const existed = parts.has(ordinal)
          const current = parts.get(ordinal) ?? {
            id: allocate(id, assistantMessageID, `text:${ordinal}`),
            sessionID: id,
            messageID: assistantMessageID,
            type: "text" as const,
            text: "",
          }
          if (event.type === "session.text.delta") {
            const delta = stringField(data, "delta") ?? ""
            if (!existed) publishPart(event, context, current)
            current.text = `${typeof current.text === "string" ? current.text : ""}${delta}`
            parts.set(ordinal, current)
            text.set(messageKey, parts)
            publishDelta(event, context, current, delta)
            return
          }
          if (event.type === "session.text.ended")
            current.text = stringField(data, "text") ?? String(current.text ?? "")
          parts.set(ordinal, current)
          text.set(messageKey, parts)
          publishPart(event, context, current)
          return
        }
        if (
          event.type === "session.reasoning.started" ||
          event.type === "session.reasoning.delta" ||
          event.type === "session.reasoning.ended"
        ) {
          const assistantMessageID = stringField(data, "assistantMessageID")
          const ordinal = numberField(data, "ordinal")
          if (!assistantMessageID || ordinal === undefined) return
          const messageKey = keyFor(id, assistantMessageID)
          const parts = reasoning.get(messageKey) ?? new Map<number, ContentPart>()
          const existed = parts.has(ordinal)
          const current = parts.get(ordinal) ?? {
            id: allocate(id, assistantMessageID, `reasoning:${ordinal}`),
            sessionID: id,
            messageID: assistantMessageID,
            type: "reasoning" as const,
            text: "",
            time: { start: Date.now() },
          }
          if (event.type === "session.reasoning.delta") {
            const delta = stringField(data, "delta") ?? ""
            if (!existed) publishPart(event, context, current)
            current.text = `${typeof current.text === "string" ? current.text : ""}${delta}`
            parts.set(ordinal, current)
            reasoning.set(messageKey, parts)
            publishDelta(event, context, current, delta)
            return
          }
          if (event.type === "session.reasoning.ended")
            current.text = stringField(data, "text") ?? String(current.text ?? "")
          parts.set(ordinal, current)
          reasoning.set(messageKey, parts)
          publishPart(event, context, current)
          return
        }
        if (event.type.startsWith("session.tool.")) {
          const assistantMessageID = stringField(data, "assistantMessageID")
          const idKey = stringField(data, "id")
          if (!assistantMessageID || !idKey) return
          const messageKey = keyFor(id, assistantMessageID)
          const byID = tools.get(messageKey) ?? new Map<string, ContentPart>()
          const startedAt = toolTimes.get(`${messageKey}\u0000${idKey}`) ?? Date.now()
          toolTimes.set(`${messageKey}\u0000${idKey}`, startedAt)
          const part = byID.get(idKey) ?? {
            id: allocate(id, assistantMessageID, `tool:${idKey}`),
            sessionID: id,
            messageID: assistantMessageID,
            type: "tool",
            callID: idKey,
            tool: stringField(data, "name") ?? "tool",
            state: { status: "pending", input: {}, raw: "" },
          }
          const state = (part.state ?? {}) as Record<string, unknown>
          if (event.type === "session.tool.input.delta") {
            state.raw = `${String(state.raw ?? "")}${stringField(data, "delta") ?? ""}`
          }
          if (event.type === "session.tool.input.ended") state.raw = stringField(data, "text") ?? ""
          if (event.type === "session.tool.called") {
            state.status = "running"
            state.input = record(data.input) ? data.input : {}
            state.metadata = {}
            state.time = { start: startedAt }
          }
          if (event.type === "session.tool.progress") state.metadata = record(data.metadata) ? data.metadata : {}
          if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
            const fresh = yield* messageFor(id, assistantMessageID, true)
            if (fresh) {
              publishMessage(event, context, fresh)
              const entry = project([fresh], context.id as Session.ID)[0]
              const projected = entry?.parts.find(
                (candidate): candidate is SessionV1.ToolPart => candidate.type === "tool" && candidate.callID === idKey,
              )
              if (projected) publishPart(event, context, terminalToolPart(projected, event.type, data, Date.now()))
            } else if (event.type === "session.tool.success") {
              const metadata = record(data.metadata) ? data.metadata : {}
              part.state = {
                status: "completed",
                input: record(state.input) ? state.input : {},
                output: textFromContent(data.content),
                title: typeof metadata.title === "string" ? metadata.title : String(part.tool ?? "tool"),
                metadata,
                time: { start: startedAt, end: Date.now() },
              }
              publishPart(event, context, part)
            } else {
              const error = record(data.error) ? stringField(data.error, "message") : stringField(data, "error")
              part.state = {
                status: "error",
                input: record(state.input) ? state.input : {},
                error: error ?? "Tool execution failed",
                ...(record(data.metadata) ? { metadata: data.metadata } : {}),
                time: { start: startedAt, end: Date.now() },
              }
              publishPart(event, context, part)
            }
            return
          }
          part.state = state
          byID.set(idKey, part)
          tools.set(messageKey, byID)
          publishPart(event, context, part)
          return
        }
        if (
          event.type === "session.step.started" ||
          event.type === "session.step.ended" ||
          event.type === "session.step.failed"
        ) {
          const assistantMessageID = stringField(data, "assistantMessageID")
          if (!assistantMessageID) return
          const message = yield* messageFor(id, assistantMessageID, true)
          publishMessage(event, context, message)
          if (event.type !== "session.step.started") deleteMessage(id, assistantMessageID)
          return
        }
        emit(event, event.type, data, context)
      }).pipe(Effect.catch(() => Effect.void))

    yield* Effect.forkScoped(Stream.runForEach(bus.subscribe(), (event) => handle(event as NativeEvent)))
    return Service.of({ running: true as const })
  }),
)

export { layer }
export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node, CoreSession.node] })
