import { readRecord, withPartPreviews, withoutAttachmentData } from "./live"
import { ArenaPrivacy } from "./privacy"

/**
 * Shared by live snapshots and archives so reconnecting preserves descendant activity. Tool results
 * leave out their attachments' data, which the app does not show, and large fields go as a preview.
 */
export function project(transcript: readonly unknown[]) {
  const messages = transcript
    .flatMap((value) => {
      const message = readRecord(value)
      const info = readRecord(
        readRecord(
          ArenaPrivacy.event({
            type: "message.updated",
            properties: { info: message?.info },
          }),
        )?.properties,
      )?.info
      const record = readRecord(info)
      if (typeof record?.id !== "string" || !Array.isArray(message?.parts)) return []
      const parts = message.parts.flatMap((part: unknown) => {
        const properties = readRecord(
          readRecord(
            ArenaPrivacy.event({
              type: "message.part.updated",
              properties: { part },
            }),
          )?.properties,
        )
        return properties?.part ? [withPartPreviews(withoutAttachmentData(properties.part))] : []
      })
      const created = readRecord(record.time)?.created
      return [{ info: { ...record, id: record.id }, parts, created: typeof created === "number" ? created : 0 }]
    })
    .sort((a, b) => a.created - b.created || a.info.id.localeCompare(b.info.id))
  return {
    messages: messages.map((message) => message.info),
    parts: Object.fromEntries(messages.map((message) => [message.info.id, message.parts])),
  }
}

/**
 * A contestant session is a fork of the whole chat, so its transcript opens with every earlier turn,
 * and the app shows a run only from its prompt on (`arenaThreadMessages`). Sent along, the earlier
 * turns put two copies of a long chat in every snapshot, past the daemon's 64 MiB socket limit: the
 * window lost its connection whenever it opened the chat or sent to it. Until the prompt is written
 * (`null`), the root session holds only the copy. A run recorded without a boundary (`undefined`)
 * keeps what follows its last user message, as the app reads it. Descendant sessions belong to this
 * turn and are kept whole.
 */
export function fromPrompt(
  transcript: ReturnType<typeof project>,
  rootSessionID: string,
  promptMessageID: string | undefined | null,
): ReturnType<typeof project> {
  const start =
    promptMessageID === null
      ? -1
      : promptMessageID
        ? transcript.messages.findIndex((message) => message.id === promptMessageID)
        : transcript.messages.findLastIndex(
            (message) => inRoot(message, rootSessionID) && readRecord(message)?.role === "user",
          )
  const kept = transcript.messages.filter(
    (message, index) => !inRoot(message, rootSessionID) || (start >= 0 && index >= start),
  )
  if (kept.length === transcript.messages.length) return transcript
  return {
    messages: kept,
    parts: Object.fromEntries(kept.map((message) => [message.id, transcript.parts[message.id] ?? []])),
  }
}

/**
 * `fromPrompt` over a run's raw messages, as an archive stores them (`{ info, parts }`): the ones a
 * window can show.
 */
export function fromPromptMessages(
  messages: readonly unknown[],
  rootSessionID: string,
  promptMessageID: string | undefined | null,
): unknown[] {
  const info = (message: unknown) => readRecord(readRecord(message)?.info)
  const root = (message: unknown) => inRoot(info(message), rootSessionID)
  const start =
    promptMessageID === null
      ? -1
      : promptMessageID
        ? messages.findIndex((message) => info(message)?.id === promptMessageID)
        : messages.findLastIndex((message) => root(message) && info(message)?.role === "user")
  return messages.filter((message, index) => !root(message) || (start >= 0 && index >= start))
}

function inRoot(message: unknown, rootSessionID: string) {
  const sessionID = readRecord(message)?.sessionID
  return sessionID === undefined || sessionID === rootSessionID
}

// A run's thread past this goes without its oldest messages; see `withinBudget`.
const ACTIVITY_LIMIT = 8 * 1024 * 1024

/**
 * A run's thread at most `limit` long. Every snapshot, vote and reply answer carries both runs'
 * threads, and past the daemon's limit the window could not load the battle, vote on it or reply to it.
 * Images and large tool fields already go as previews, so only an extreme turn comes near this. It
 * leaves out the oldest messages first, but never the prompt or one the pane still acts on: each
 * session's newest message, which a subagent card reads its state from; a subagent's task call, which
 * places its card; a tool call waiting on a question or permission, which the pane answers inline; and
 * the latest task list. It counts the messages it left out in `activityOmitted` for the pane to say so.
 */
export function withinBudget(
  transcript: ReturnType<typeof project>,
  rootSessionID: string,
  promptMessageID: string | undefined | null,
  limit = ACTIVITY_LIMIT,
): ReturnType<typeof project> & { readonly activityOmitted?: number } {
  const sizes = transcript.messages.map(
    (message) => JSON.stringify(message).length + JSON.stringify(transcript.parts[message.id] ?? []).length,
  )
  let total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= limit) return transcript
  const kept = new Set<string>()
  // `fromPrompt` kept a boundary-less run from its first root user message on.
  const boundary =
    promptMessageID ??
    transcript.messages.find((message) => inRoot(message, rootSessionID) && readRecord(message)?.role === "user")
      ?.id
  if (boundary) kept.add(boundary)
  let tasks: string | undefined
  for (const message of transcript.messages) {
    for (const part of transcript.parts[message.id] ?? []) {
      const record = readRecord(part)
      if (record?.type !== "tool") continue
      const status = readRecord(record.state)?.status
      if (status === "pending" || status === "running" || record.tool === "task") kept.add(message.id)
      // The pane's task list is the latest one the run finished writing.
      if (record.tool === "todowrite" && status === "completed") tasks = message.id
    }
  }
  if (tasks) kept.add(tasks)
  const newestBySession = new Map<string, string>()
  for (const message of transcript.messages) {
    const sessionID = readRecord(message)?.sessionID
    newestBySession.set(typeof sessionID === "string" ? sessionID : rootSessionID, message.id)
  }
  for (const id of newestBySession.values()) kept.add(id)
  const omitted = new Set<string>()
  transcript.messages.forEach((message, index) => {
    if (total <= limit || kept.has(message.id)) return
    omitted.add(message.id)
    total -= sizes[index] ?? 0
  })
  const messages = transcript.messages.filter((message) => !omitted.has(message.id))
  return {
    messages,
    parts: Object.fromEntries(messages.map((message) => [message.id, transcript.parts[message.id] ?? []])),
    activityOmitted: omitted.size,
  }
}

/** One part as a window gets it, but whole: what `withPartPreviews` shortened in a snapshot. */
export function windowPart(part: unknown): unknown {
  const properties = readRecord(
    readRecord(ArenaPrivacy.event({ type: "message.part.updated", properties: { part } }))?.properties,
  )
  return properties?.part ? withoutAttachmentData(properties.part) : null
}

/** `windowPart` for the part of `transcript`, a run's messages, with this ID. */
export function wholePart(transcript: readonly unknown[], partID: string): unknown {
  for (const value of transcript) {
    const parts = readRecord(value)?.parts
    if (!Array.isArray(parts)) continue
    const part = parts.find((item: unknown) => readRecord(item)?.id === partID)
    if (part !== undefined) return windowPart(part)
  }
  return null
}

export * as ArenaTranscript from "./transcript"
