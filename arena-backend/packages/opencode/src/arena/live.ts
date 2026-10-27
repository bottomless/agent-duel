import { RESEARCH_IMAGE_REFERENCE } from "@agent-duel/arena-service/research-protocol"
import { ArenaPrivacy } from "./privacy"
import { REDACTED_THINKING } from "@agent-duel/arena-service/reasoning"

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
  rootSessionID: string
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

/**
 * Keep legacy reasoning private too: the cloud shield protects new requests, while old archives
 * still contain plaintext. Tool attachment data is omitted to stay below the daemon socket limit.
 */
export function publicPart<T>(part: T): T {
  const record = readRecord(part)
  if (record?.type === "reasoning" || record?.type === "thought") {
    return { ...record, text: REDACTED_THINKING, metadata: undefined } as T
  }
  const state = readRecord(record?.state)
  if (record?.type !== "tool" || !state || !Array.isArray(state.attachments)) return part
  const attachments = state.attachments.map((attachment) => {
    const value = readRecord(attachment)
    return value ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "url")) : attachment
  })
  return { ...record, state: { ...state, attachments } } as T
}

// A tool field past this is sent as its start and end, and an attached file past it without its data;
// see `withPartPreviews`.
const PREVIEW_LIMIT = 6 * 1024
const PREVIEW_HEAD = 3 * 1024
const PREVIEW_TAIL = 1024

function preview(value: string): string {
  const omitted = value.length - PREVIEW_HEAD - PREVIEW_TAIL
  return `${value.slice(0, PREVIEW_HEAD)}\n\n… ${omitted} more characters …\n\n${value.slice(-PREVIEW_TAIL)}`
}

/**
 * A part's large fields go to the window shortened. A tool call sends its start and end: command
 * output, a read file, a written file, an edit's text, and their copies in `metadata`. An image or file
 * pasted into the prompt or a follow-up goes without its data, as does one an archive names by its
 * content. Sent whole, a long turn made every snapshot, vote and reply answer, and part update as large
 * as everything its runs had printed and been sent: a turn of follow-ups with four photos each passed
 * the daemon's limit at its eighth. The part lists what was shortened in `previewed` (`state.previewed`
 * for a tool call), and the app fetches it whole when it shows the image or opens the call
 * (`arena.run.get_part`). Small fields, such as a subagent's `sessionId` or a question's `answers`, are
 * never this long and stay as they are.
 */
export function withPartPreviews<T>(part: T): T {
  const record = readRecord(part)
  if (record?.type === "file") {
    const url = record.url
    const large =
      typeof url === "string" &&
      (url.startsWith(RESEARCH_IMAGE_REFERENCE) || (url.startsWith("data:") && url.length > PREVIEW_LIMIT))
    return large ? ({ ...record, url: "", previewed: ["url"] } as T) : part
  }
  const state = readRecord(record?.state)
  if (record?.type !== "tool" || !state) return part
  const previewed: string[] = []
  const shorten = (value: Record<string, unknown>, path: string, depth: number): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (typeof item === "string" && item.length > PREVIEW_LIMIT) {
          previewed.push(`${path}${key}`)
          return [key, preview(item)]
        }
        const nested = readRecord(item)
        return [key, nested && depth > 0 ? shorten(nested, `${path}${key}.`, depth - 1) : item]
      }),
    )
  const next: Record<string, unknown> = { ...state }
  if (typeof state.output === "string" && state.output.length > PREVIEW_LIMIT) {
    previewed.push("output")
    next.output = preview(state.output)
  }
  const input = readRecord(state.input)
  if (input) next.input = shorten(input, "input.", 1)
  const metadata = readRecord(state.metadata)
  if (metadata) next.metadata = shorten(metadata, "metadata.", 1)
  if (previewed.length === 0) return part
  return { ...record, state: { ...next, previewed } } as T
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
      if (message) change = { kind: "message", runId, message }
    } else if (type === "message.part.updated") {
      const part = readPart(publicPart(properties.part))
      if (!part) return
      const time = readRecord(part.time)
      if ((part.type === "text" || part.type === "reasoning") && typeof time?.end !== "number") {
        const current = this.pending.get(runId) ?? new Map<string, LivePart>()
        current.set(part.id, part)
        this.pending.set(runId, current)
      } else this.pending.get(runId)?.delete(part.id)
      change = { kind: "part", runId, part: withPartPreviews(part) }
    } else if (type === "message.part.delta") {
      if (properties.field !== "text" || typeof properties.delta !== "string" || typeof properties.partID !== "string")
        return
      const current = this.pending.get(runId)
      const previous = current?.get(properties.partID)
      if (!current || !previous || typeof previous.text !== "string") {
        this.dirty()
        return
      }
      if (previous.type === "reasoning" || previous.type === "thought") {
        const redacted: LiveChange = { kind: "part", runId, part: previous }
        this.emit({
          turnID: binding.turnID,
          rootSessionID: binding.rootSessionID,
          change: redacted,
          replacement: redacted,
        })
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
      this.emit({
        turnID: binding.turnID,
        rootSessionID: binding.rootSessionID,
        change: delta,
        replacement: { kind: "part", runId, part },
      })
      return
    } else if (type === "message.removed" && typeof properties.messageID === "string") {
      for (const part of this.partsFor(runId))
        if (part.messageID === properties.messageID) this.pending.get(runId)?.delete(part.id)
      change = { kind: "remove_message", runId, messageId: properties.messageID }
    } else if (
      type === "message.part.removed" &&
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
    if (change) this.emit({ turnID: binding.turnID, rootSessionID: binding.rootSessionID, change, replacement: change })
  }

  private emit(event: LiveNotification) {
    for (const listener of this.listeners) listener(event)
  }
}

export * as ArenaLiveFeed from "./live"
