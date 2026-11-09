import { Message, type ContentPart, type SystemPart } from "@opencode/ai"
import type { Content } from "@opencode/schema/tool"

/**
 * Keeps a contestant request under the hosted control plane's body limit. Vercel refuses a function
 * request body over 4.5 MB before Arena's code runs, so the engine sees a bare 413 and the side
 * fails. Images are what grows a body that far: every image a tool read stays in history as base64
 * and is sent again on every later call.
 *
 * Over `TRIGGER`, the oldest images are left out until the body is back under `TARGET`; the gap
 * makes a removal rare, since each one rewrites the prompt prefix and costs a cache miss. Images
 * from the newest step are never removed for older ones' sake. When they do not fit together, the
 * first ones in the step are sent and the rest get a note asking for a separate read; an image that
 * cannot fit even alone gets a note asking for a smaller file, so the agent does not retry it.
 *
 * An agent that needs more images at once than a request holds, and keeps no written notes, reads
 * them again in a loop: each read removes another one. After the same image was removed twice, a
 * further read of it is not attached, so the loop ends whatever the model does. The same image is
 * the same file with the same bytes: agents render new versions of a slide to the same path.
 *
 * Decisions are replayed from the start of history on every request instead of being stored. History
 * only grows, so each request reaches the same decisions as the one before it and the prefix stays
 * stable until the next removal. Only the request changes: canonical history keeps every image.
 */
export const REQUEST_BYTES_TRIGGER = 3_800_000
export const REQUEST_BYTES_TARGET = 2_500_000

export interface RequestSize {
  readonly system: readonly SystemPart[]
  readonly tools?: Record<string, unknown>
  readonly messages: readonly Message[]
}

export interface RequestSizeReport {
  /** Estimated body before and after, in bytes. */
  readonly before: number
  readonly after: number
  readonly removed: number
  readonly deferred: number
  readonly oversized: number
  readonly exhausted: number
}

type Decision = "sent" | "removed" | "deferred" | "oversized" | "exhausted"

interface Slot {
  readonly message: number
  readonly part: number
  /** Index inside a tool result's content; absent for a media part. */
  readonly item?: number
  readonly bytes: number
  readonly name?: string
  readonly user: boolean
  /** Identifies a tool image's content, for counting how often the same image was removed. */
  readonly content?: string
  decision: Decision
  /** Room an oversized image had, for its note. */
  room?: number
}

// JSON keys, quotes and the provider's per-message wrapping that a part's own JSON does not show.
const ENVELOPE_BYTES = 8_192
const MEDIA_PART_BYTES = 128
// Removals of one image after which a new read of the same content is no longer attached.
const MAX_REMOVALS = 2

const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")

const mediaBytes = (part: Extract<ContentPart, { type: "media" }>) => {
  const source = part.media.source
  if (source.type === "base64") return Buffer.byteLength(source.data)
  if (source.type === "bytes") return Math.ceil(source.data.byteLength / 3) * 4
  return 0
}

const toolContent = (part: ContentPart) =>
  part.type === "tool-result" && part.result.type === "content" ? part.result.value : undefined

/** A message's bytes without its image payloads, which `slots` counts one by one. */
function fixedBytes(message: Message) {
  let media = 0
  const json = JSON.stringify(message, function (key, value) {
    if (key === "media" && this?.type === "media") {
      if (!isImage(this.media.mediaType)) media += mediaBytes(this)
      return undefined
    }
    if (key === "uri" && this?.type === "file" && isImage(this.mime)) return ""
    return value
  })
  return Buffer.byteLength(json) + media + MEDIA_PART_BYTES
}

function slots(message: Message, index: number): Slot[] {
  const user = message.role === "user"
  return message.content.flatMap((part, partIndex): Slot[] => {
    if (part.type === "media")
      return isImage(part.media.mediaType)
        ? [{ message: index, part: partIndex, bytes: mediaBytes(part), name: part.filename, user, decision: "sent" }]
        : []
    return (toolContent(part) ?? []).flatMap((item, itemIndex): Slot[] =>
      item.type === "file" && isImage(item.mime)
        ? [
            {
              message: index,
              part: partIndex,
              item: itemIndex,
              bytes: Buffer.byteLength(item.uri),
              name: item.name,
              user,
              content: user ? undefined : `${item.name ?? ""}:${Bun.hash(item.uri).toString(36)}`,
              decision: "sent",
            },
          ]
        : [],
    )
  })
}

const megabytes = (bytes: number) => (Math.max(0, bytes) / 1_000_000).toFixed(1)

function note(slot: Slot) {
  const image = slot.name ? `Image ${slot.name}` : "This image"
  if (slot.decision === "removed")
    // Reasoning is sealed between calls, so a removed image is lost unless the agent wrote it down.
    return `[${image} was removed to keep the request under its size limit. Use what you wrote down about it. If you need to see it again, ${slot.user ? "ask the user to attach it again" : "read the file again"}.]`
  if (slot.decision === "deferred")
    return `[${image} was not attached: the images read in one step must fit in one request together, and this one did not fit with the others. Read it again in a separate step. Older images are removed from later requests to make room, so write down what you need from each image as soon as you see it.]`
  if (slot.decision === "exhausted")
    return `[${image} was not attached: it was already removed twice, because a request cannot hold it together with the other images you are using. Work from what you wrote down about it.]`
  return `[${image} was not attached: it is ${megabytes(slot.bytes)} MB encoded, and a request has room for about ${megabytes(slot.room ?? 0)} MB of images. Crop it or export it at a lower resolution, then read the smaller file.]`
}

/** Decides which images each request in the history could carry, oldest request first. */
function decide(request: RequestSize) {
  const overhead =
    ENVELOPE_BYTES +
    Buffer.byteLength(JSON.stringify(request.system)) +
    Buffer.byteLength(JSON.stringify(request.tools ?? {}))
  const all: Slot[] = []
  let fixed = overhead
  // Images after this index came from the newest step: the tool results of the latest assistant
  // message, or the user's new message.
  let stepStart = 0
  const removals = new Map<string, number>()
  const sent = () => all.reduce((sum, slot) => sum + (slot.decision === "sent" ? slot.bytes : 0), 0)

  const check = () => {
    let body = fixed + sent()
    if (body <= REQUEST_BYTES_TRIGGER) return
    const older = all.slice(0, stepStart).filter((slot) => slot.decision === "sent")
    for (const slot of [...older.filter((slot) => !slot.user), ...older.filter((slot) => slot.user)]) {
      if (body <= REQUEST_BYTES_TARGET) break
      slot.decision = "removed"
      body -= slot.bytes
      if (slot.content) removals.set(slot.content, (removals.get(slot.content) ?? 0) + 1)
    }
    if (body <= REQUEST_BYTES_TRIGGER) return
    // Every older image is gone, so what is left is the newest step: send it in order while it fits.
    let used = fixed
    for (const slot of all.slice(stepStart)) {
      if (slot.decision !== "sent") continue
      if (used + slot.bytes <= REQUEST_BYTES_TRIGGER) {
        used += slot.bytes
        continue
      }
      if (fixed + slot.bytes <= REQUEST_BYTES_TRIGGER) {
        slot.decision = "deferred"
        continue
      }
      slot.decision = "oversized"
      slot.room = REQUEST_BYTES_TRIGGER - fixed
    }
  }

  request.messages.forEach((message, index) => {
    // An assistant message is a model call: its request held everything before it.
    if (message.role === "assistant") {
      check()
      stepStart = all.length
    }
    fixed += fixedBytes(message)
    for (const slot of slots(message, index)) {
      if (slot.content && (removals.get(slot.content) ?? 0) >= MAX_REMOVALS) slot.decision = "exhausted"
      all.push(slot)
    }
  })
  check()
  return { all, before: fixed + all.reduce((sum, slot) => sum + slot.bytes, 0), after: fixed + sent() }
}

function replaced(message: Message, notes: ReadonlyMap<string, string>, index: number) {
  const content = message.content.map((part, partIndex): ContentPart => {
    const text = notes.get(`${index}:${partIndex}`)
    if (text !== undefined) return Message.text(text)
    const value = toolContent(part)
    if (part.type !== "tool-result" || part.result.type !== "content" || value === undefined) return part
    const items = value.map((item, itemIndex): Content => {
      const itemText = notes.get(`${index}:${partIndex}:${itemIndex}`)
      return itemText === undefined ? item : { type: "text", text: itemText }
    })
    return { ...part, result: { ...part.result, value: items } }
  })
  return new Message({ ...message, content })
}

/** Leaves the images out of the request that the hosted body limit cannot take, with a note for each. */
export function boundRequestSize(request: RequestSize): {
  readonly messages: Message[]
  readonly report?: RequestSizeReport
} {
  const { all, before, after } = decide(request)
  const changed = all.filter((slot) => slot.decision !== "sent")
  if (changed.length === 0) return { messages: [...request.messages] }
  const notes = new Map(
    changed.map((slot) => [
      slot.item === undefined ? `${slot.message}:${slot.part}` : `${slot.message}:${slot.part}:${slot.item}`,
      note(slot),
    ]),
  )
  const touched = new Set(changed.map((slot) => slot.message))
  return {
    messages: request.messages.map((message, index) =>
      touched.has(index) ? replaced(message, notes, index) : message,
    ),
    report: {
      before,
      after,
      removed: changed.filter((slot) => slot.decision === "removed").length,
      deferred: changed.filter((slot) => slot.decision === "deferred").length,
      oversized: changed.filter((slot) => slot.decision === "oversized").length,
      exhausted: changed.filter((slot) => slot.decision === "exhausted").length,
    },
  }
}
