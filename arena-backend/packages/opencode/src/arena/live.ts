import { ArenaPrivacy } from "./privacy"

export interface LiveBinding {
  readonly runID: string
  readonly turnID: string
  readonly rootSessionID: string
}
export interface LiveRecord extends Record<string, unknown> {
  id: string
  sessionID: string
}
export interface LivePart extends LiveRecord {
  messageID: string
}
export type LiveChange =
  | { kind: "message"; runId: string; message: LiveRecord }
  | { kind: "part"; runId: string; part: LivePart }
  | { kind: "text"; runId: string; messageId: string; partId: string; offset: number; text: string }
  | { kind: "remove_message"; runId: string; messageId: string }
  | { kind: "remove_part"; runId: string; messageId: string; partId: string }
export interface LiveNotification {
  turnID: string
  change: LiveChange
  // Bootstrap needs the latest value, not an append which the DB read may already contain.
  replacement: Exclude<LiveChange, { kind: "text" }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
}
function readMessage(value: unknown): LiveRecord | undefined {
  const item = readRecord(value)
  if (item && typeof item.id === "string" && typeof item.sessionID === "string")
    return { ...item, id: item.id, sessionID: item.sessionID }
}
function readPart(value: unknown): LivePart | undefined {
  const item = readMessage(value)
  if (item && typeof item.messageID === "string") return { ...item, messageID: item.messageID }
}

export class ArenaLive {
  private readonly listeners = new Set<(event: LiveNotification) => void>()
  private readonly pending = new Map<string, Map<string, LivePart>>()
  private readonly dirtyListeners = new Set<() => void>()

  subscribe(listener: (event: LiveNotification) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  onDirty(listener: () => void): () => void {
    this.dirtyListeners.add(listener)
    return () => {
      this.dirtyListeners.delete(listener)
    }
  }
  dirty() {
    for (const listener of this.dirtyListeners) listener()
  }
  partsFor(runID: string): LivePart[] {
    return [...(this.pending.get(runID)?.values() ?? [])]
  }
  release(runID: string) {
    this.pending.delete(runID)
  }
  close() {
    this.pending.clear()
    this.listeners.clear()
    this.dirtyListeners.clear()
  }

  capture(binding: LiveBinding, payload: unknown) {
    const envelope = readRecord(payload)
    if (!envelope || typeof envelope.type !== "string" || envelope.type === "sync") return
    const safe = readRecord(ArenaPrivacy.event(payload))
    const properties = readRecord(safe?.properties)
    if (!properties) return
    const runId = binding.runID
    const type = envelope.type
    let change: Exclude<LiveChange, { kind: "text" }> | undefined
    if (type === "message.updated") {
      const message = readMessage(properties.info)
      if (message?.sessionID === binding.rootSessionID) change = { kind: "message", runId, message }
    } else if (type === "message.part.updated") {
      const part = readPart(properties.part)
      if (!part || part.sessionID !== binding.rootSessionID) return
      const time = readRecord(part.time)
      if ((part.type === "text" || part.type === "reasoning") && typeof time?.end !== "number") {
        const current = this.pending.get(runId) ?? new Map<string, LivePart>()
        current.set(part.id, part)
        this.pending.set(runId, current)
      } else this.pending.get(runId)?.delete(part.id)
      change = { kind: "part", runId, part }
    } else if (type === "message.part.delta") {
      if (
        properties.sessionID !== binding.rootSessionID ||
        properties.field !== "text" ||
        typeof properties.delta !== "string" ||
        typeof properties.partID !== "string"
      )
        return
      const current = this.pending.get(runId)
      const previous = current?.get(properties.partID)
      if (!current || !previous || typeof previous.text !== "string") {
        this.dirty()
        return
      }
      const part = { ...previous, text: previous.text + properties.delta }
      current.set(part.id, part)
      const delta: LiveChange = {
        kind: "text",
        runId,
        messageId: part.messageID,
        partId: part.id,
        offset: previous.text.length,
        text: properties.delta,
      }
      this.emit({ turnID: binding.turnID, change: delta, replacement: { kind: "part", runId, part } })
      return
    } else if (
      type === "message.removed" &&
      properties.sessionID === binding.rootSessionID &&
      typeof properties.messageID === "string"
    ) {
      for (const part of this.partsFor(runId))
        if (part.messageID === properties.messageID) this.pending.get(runId)?.delete(part.id)
      change = { kind: "remove_message", runId, messageId: properties.messageID }
    } else if (
      type === "message.part.removed" &&
      properties.sessionID === binding.rootSessionID &&
      typeof properties.messageID === "string" &&
      typeof properties.partID === "string"
    ) {
      this.pending.get(runId)?.delete(properties.partID)
      change = { kind: "remove_part", runId, messageId: properties.messageID, partId: properties.partID }
    } else if (
      type.startsWith("permission.") ||
      type.startsWith("question.") ||
      type === "session.status" ||
      type === "session.error"
    )
      this.dirty()
    if (change) this.emit({ turnID: binding.turnID, change, replacement: change })
  }

  private emit(event: LiveNotification) {
    for (const listener of this.listeners) listener(event)
  }
}

export * as ArenaLiveFeed from "./live"
