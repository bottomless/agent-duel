import {
  AssistantMessage,
  Message,
  ToolMessage,
  UserMessage,
  type ContentPart,
  type SystemPart,
  type ToolResultPart,
} from "@opencode/ai"
import type { Content } from "@opencode/schema/tool"
import { MEDIA_FILE_BYTES } from "@agent-duel/arena-service/media"

/**
 * Keeps a contestant request within what it can carry. Images are what grows a request: every image
 * a tool read stays in history and goes out again on every later call.
 *
 * Two limits apply. The hosted control plane takes at most about 4.5 MB per request (Vercel refuses
 * more before Arena's code runs, and the side fails on a bare 413), but a hosted request names each
 * image or PDF instead of including it (`media-reference.ts`): the file goes straight to the control
 * plane's object store, so it counts only its reference there, whatever its size. That holds only
 * once the store has taken an upload: until then, and for a control plane without the upload route,
 * media counts in full (`MediaCarriage`). The provider takes `UPSTREAM_IMAGES` images and
 * `UPSTREAM_MEDIA_BYTES` of media in one request, whatever the mode.
 *
 * Past a limit, a request leaves out its oldest tool images until it is `IMAGE_ROOM_KEPT` of the way
 * to each one. Each removal rewrites the prompt prefix, and Claude, which caches only from one
 * breakpoint at the end, then reads nothing from cache and writes the whole conversation again.
 * Trimming only as far as it took to fit did that on every later step that read an image; the room
 * a trim leaves keeps the prefix in place for many steps. The user's pasted images go only as far
 * as it takes to fit. Images from the newest step are never removed for older ones' sake. When they
 * do not fit together, the first ones in the step are sent and the rest get a note asking for a
 * separate read; an image that cannot fit even alone gets a note asking for a smaller file, so the
 * agent does not retry it.
 *
 * An agent that needs more images at once than a request holds, and keeps no written notes, reads
 * them again in a loop: each read removes another one. After the same image was removed twice, a
 * further read of it is not attached, so the loop ends whatever the model does. The same image is
 * the same file with the same bytes: agents render new versions of a slide to the same path.
 *
 * Decisions are replayed from the start of history on every request instead of being stored. History
 * only grows, so each request reaches the same decisions as the one before it. Only the request
 * changes: canonical history keeps every image.
 */

// Measured on 2026-11-09 against agentduel.com: a 4,494,157-byte body passes and one byte more gets
// Vercel's FUNCTION_PAYLOAD_TOO_LARGE. Headers count against the same limit (a 2,009-byte header
// cost 1,508 bytes of body over HTTP/2), so the engine's own headers come off it.
const HOSTED_REQUEST_LIMIT = 4_494_157
// The account token and the x-arena-* and x-opencode-* ids, which are well under this.
const HEADER_ALLOWANCE = 4_096
export const REQUEST_BYTES_LIMIT = HOSTED_REQUEST_LIMIT - HEADER_ALLOWANCE
// The largest file sent by reference. Its upload goes to the store, not through a hosted function,
// so the body limit above does not bound it: this is the most an upload URL takes, which is more
// than `UPSTREAM_MEDIA_BYTES` lets one file be.
export const MEDIA_UPLOAD_BYTES = MEDIA_FILE_BYTES
// What one provider request carries. Guesses, kept under the lowest published limits in the pool:
// Anthropic takes 100 images and 32 MB a request, and Google's inline data stops near 20 MB.
export const UPSTREAM_IMAGES = 90
export const UPSTREAM_MEDIA_BYTES = 16_000_000
// The most one image may be, encoded. Claude takes 10 MB an image from Anthropic and 5 MB through
// Bedrock and Vertex, which OpenRouter can route it to. The hosted body limit used to keep every
// image under this; by reference nothing else does, so a hosted request applies it. BYOK does not.
export const UPSTREAM_IMAGE_BYTES = 5_000_000
// How far toward each limit a trim goes. A guess: the 30% it frees holds many steps of screenshots
// before the next trim, while most of the images a chat has read stay in the request.
export const IMAGE_ROOM_KEPT = 0.7

/**
 * How a request's images and PDFs travel. `reference`: to a hosted control plane whose store has
 * taken an upload, by reference (`media-reference.ts`). `inline`: to a hosted control plane in the body,
 * because it has no upload route or this process has not seen one succeed yet. `local`: in process
 * (BYOK), where the hosted body limit does not apply.
 */
export type MediaCarriage = "reference" | "inline" | "local"

export interface RequestSize {
  readonly system: readonly SystemPart[]
  readonly tools?: Record<string, unknown>
  readonly messages: readonly Message[]
}

export interface RequestSizeReport {
  /** Estimated body the control plane receives, before and after, in bytes. */
  readonly before: number
  readonly after: number
  /** Media bytes the provider receives, before and after. */
  readonly mediaBefore: number
  readonly mediaAfter: number
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
  /** Encoded size, which the provider receives. */
  readonly bytes: number
  /** What it adds to the control plane's body: its reference, or itself when it travels in the body. */
  readonly wire: number
  readonly name?: string
  readonly user: boolean
  /** Identifies a tool image's content, for counting how often the same image was removed. */
  readonly content?: string
  decision: Decision
  /** Room an oversized image had, for its note. */
  room?: number
  /** It is over `UPSTREAM_IMAGE_BYTES` on its own, whatever else the request holds. */
  overImageLimit?: boolean
}

// JSON keys, quotes and the provider's per-message wrapping that a part's own JSON does not show.
// With these, the estimate ran 0.5–1.2% above the real body in QA, never below it.
const ENVELOPE_BYTES = 8_192
const MEDIA_PART_BYTES = 128
// `arena-media:sha256:<64 hex>:<media type>` and the part around it.
const REFERENCE_BYTES = 160
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

/**
 * The provider metadata the request carries for a part. Only a reasoning part's metadata (its
 * reasoning details) and a tool call's `extraContent` go out (`ai/src/protocols/openai-chat.ts`). A
 * streamed step stores its reasoning details on every part, tool calls included, and for an Arena
 * contestant those are sealed envelopes about twice the size of the reasoning. Counted on each part,
 * a stubbed reasoning-heavy chat looked 1.3 to 2.7 times its real size and lost images far below the
 * limit.
 */
function sentMetadata(part: unknown, metadata: unknown) {
  if ((part as { type?: unknown } | null)?.type === "reasoning") return metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const kept = Object.entries(metadata).flatMap(([provider, value]) =>
    value && typeof value === "object" && "extraContent" in value
      ? [[provider, { extraContent: (value as { extraContent: unknown }).extraContent }] as const]
      : [],
  )
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

/** What base64 media of this encoded size adds to the control plane's body. */
const wireBytes = (encoded: number, carriage: MediaCarriage) =>
  carriage === "reference" && Math.floor((encoded * 3) / 4) <= MEDIA_UPLOAD_BYTES ? REFERENCE_BYTES : encoded

/**
 * A message's bytes as the control plane receives it, and the bytes of its other media (PDFs),
 * without its image payloads, which `slots` counts one by one.
 */
function fixedBytes(message: Message, carriage: MediaCarriage) {
  let wire = 0
  let media = 0
  const json = JSON.stringify(message, function (key, value) {
    // Core hands hooks each stored message's metadata and strips it before the request is sent.
    if (key === "metadata" && this === message) return undefined
    if (key === "media" && this?.type === "media") {
      if (!isImage(this.media.mediaType)) {
        const bytes = mediaBytes(this)
        media += bytes
        wire += wireBytes(bytes, carriage)
      }
      return undefined
    }
    if (key === "uri" && this?.type === "file" && typeof value === "string") {
      if (isImage(this.mime)) return ""
      if (value.startsWith("data:")) {
        media += value.length
        wire += wireBytes(value.length, carriage)
        return ""
      }
    }
    if (key === "providerMetadata") return sentMetadata(this, value)
    return value
  })
  return { wire: Buffer.byteLength(json) + wire + MEDIA_PART_BYTES, media }
}

function slots(message: Message, index: number, carriage: MediaCarriage): Slot[] {
  const user = message.role === "user"
  return message.content.flatMap((part, partIndex): Slot[] => {
    if (part.type === "media")
      return isImage(part.media.mediaType)
        ? [
            {
              message: index,
              part: partIndex,
              bytes: mediaBytes(part),
              wire: wireBytes(mediaBytes(part), carriage),
              name: part.filename,
              user,
              decision: "sent",
            },
          ]
        : []
    return (toolContent(part) ?? []).flatMap((item, itemIndex): Slot[] =>
      item.type === "file" && isImage(item.mime)
        ? [
            {
              message: index,
              part: partIndex,
              item: itemIndex,
              bytes: Buffer.byteLength(item.uri),
              wire: wireBytes(Buffer.byteLength(item.uri), carriage),
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
  const room = slot.overImageLimit
    ? `a model takes at most about ${megabytes(UPSTREAM_IMAGE_BYTES)} MB per image`
    : `a request has room for about ${megabytes(slot.room ?? 0)} MB of images`
  // The user attached it, so there is no file for the agent to shrink.
  const smaller = slot.user
    ? "Ask the user to attach a smaller copy, cropped or exported at a lower resolution."
    : "Crop it or export it at a lower resolution, then read the smaller file."
  return `[${image} was not attached: it is ${megabytes(slot.bytes)} MB encoded, and ${room}. ${smaller}]`
}

type Load = { wire: number; media: number; images: number }

/** Decides which images each request in the history could carry, oldest request first. */
function decide(request: RequestSize, carriage: MediaCarriage) {
  // An in-process request never passes the hosted limit, only the provider's.
  const bodyLimit = carriage === "local" ? Number.POSITIVE_INFINITY : REQUEST_BYTES_LIMIT
  const fits = (load: Load) =>
    load.wire <= bodyLimit && load.media <= UPSTREAM_MEDIA_BYTES && load.images <= UPSTREAM_IMAGES
  const overhead =
    ENVELOPE_BYTES +
    Buffer.byteLength(JSON.stringify(request.system)) +
    Buffer.byteLength(JSON.stringify(request.tools ?? {}))
  const all: Slot[] = []
  const fixed = { wire: overhead, media: 0 }
  // Images after this index came from the newest step: the tool results of the latest assistant
  // message, or the user's new message.
  let stepStart = 0
  const removals = new Map<string, number>()
  const load = (slots: ReadonlyArray<Slot>): Load =>
    slots.reduce(
      (total, slot) =>
        slot.decision === "sent"
          ? { wire: total.wire + slot.wire, media: total.media + slot.bytes, images: total.images + 1 }
          : total,
      { wire: fixed.wire, media: fixed.media, images: 0 },
    )

  const check = () => {
    const current = load(all)
    if (fits(current)) return
    const older = all.slice(0, stepStart).filter((slot) => slot.decision === "sent")
    // Tool images go well under each limit; the user's pasted images only as far as it takes to fit.
    const settled = (total: Load) =>
      total.wire <= fixed.wire + Math.max(0, bodyLimit - fixed.wire) * IMAGE_ROOM_KEPT &&
      total.media <= fixed.media + Math.max(0, UPSTREAM_MEDIA_BYTES - fixed.media) * IMAGE_ROOM_KEPT &&
      total.images <= UPSTREAM_IMAGES * IMAGE_ROOM_KEPT
    for (const slot of [...older.filter((slot) => !slot.user), ...older.filter((slot) => slot.user)]) {
      if (slot.user ? fits(current) : settled(current)) break
      slot.decision = "removed"
      current.wire -= slot.wire
      current.media -= slot.bytes
      current.images--
      if (slot.content) removals.set(slot.content, (removals.get(slot.content) ?? 0) + 1)
    }
    if (fits(current)) return
    // Every older image is gone, so what is left is the newest step: send it in order while it fits.
    const used: Load = { wire: fixed.wire, media: fixed.media, images: 0 }
    for (const slot of all.slice(stepStart)) {
      if (slot.decision !== "sent") continue
      const next = { wire: used.wire + slot.wire, media: used.media + slot.bytes, images: used.images + 1 }
      if (fits(next)) {
        Object.assign(used, next)
        continue
      }
      if (fits({ wire: fixed.wire + slot.wire, media: fixed.media + slot.bytes, images: 1 })) {
        slot.decision = "deferred"
        continue
      }
      slot.decision = "oversized"
      // By reference only the provider's limit stands in the way, also for a file over the upload
      // cap, which is over that limit too.
      slot.room =
        carriage === "reference"
          ? UPSTREAM_MEDIA_BYTES - fixed.media
          : Math.min(bodyLimit - fixed.wire, UPSTREAM_MEDIA_BYTES - fixed.media)
    }
  }

  request.messages.forEach((message, index) => {
    // An assistant message is a model call: its request held everything before it.
    if (message.role === "assistant") {
      check()
      stepStart = all.length
    }
    const bytes = fixedBytes(message, carriage)
    fixed.wire += bytes.wire
    fixed.media += bytes.media
    for (const slot of slots(message, index, carriage)) {
      if (slot.content && (removals.get(slot.content) ?? 0) >= MAX_REMOVALS) slot.decision = "exhausted"
      else if (carriage !== "local" && slot.bytes > UPSTREAM_IMAGE_BYTES) {
        slot.decision = "oversized"
        slot.overImageLimit = true
      }
      all.push(slot)
    }
  })
  check()
  const after = load(all)
  return {
    all,
    before: fixed.wire + all.reduce((sum, slot) => sum + slot.wire, 0),
    after: after.wire,
    mediaBefore: fixed.media + all.reduce((sum, slot) => sum + slot.bytes, 0),
    mediaAfter: after.media,
  }
}

function replaced(message: Message, notes: ReadonlyMap<string, string>, index: number): Message {
  const result = (part: ToolResultPart, partIndex: number): ToolResultPart => {
    const value = toolContent(part)
    if (part.result.type !== "content" || value === undefined) return part
    const items = value.map((item, itemIndex): Content => {
      const itemText = notes.get(`${index}:${partIndex}:${itemIndex}`)
      return itemText === undefined ? item : { type: "text", text: itemText }
    })
    return { ...part, result: { ...part.result, value: items } }
  }
  const note = (partIndex: number) => {
    const text = notes.get(`${index}:${partIndex}`)
    return text === undefined ? undefined : Message.text(text)
  }
  // Each role has its own message class with its own part types.
  switch (message.role) {
    case "system":
      return message
    case "user":
      return new UserMessage({ ...message, content: message.content.map((part, i) => note(i) ?? part) })
    case "tool":
      return new ToolMessage({ ...message, content: message.content.map(result) })
    case "assistant":
      return new AssistantMessage({
        ...message,
        content: message.content.map((part, i) => note(i) ?? (part.type === "tool-result" ? result(part, i) : part)),
      })
  }
}

/** Leaves the images out of the request that the hosted body limit cannot take, with a note for each. */
export function boundRequestSize(
  request: RequestSize,
  carriage: MediaCarriage,
): {
  readonly messages: Message[]
  readonly report?: RequestSizeReport
} {
  const { all, before, after, mediaBefore, mediaAfter } = decide(request, carriage)
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
      mediaBefore,
      mediaAfter,
      removed: changed.filter((slot) => slot.decision === "removed").length,
      deferred: changed.filter((slot) => slot.decision === "deferred").length,
      oversized: changed.filter((slot) => slot.decision === "oversized").length,
      exhausted: changed.filter((slot) => slot.decision === "exhausted").length,
    },
  }
}
