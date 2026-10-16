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
 * window lost its connection whenever it opened the chat or sent to it. Until the prompt is written,
 * the root session holds only the copy. A run recorded without a boundary keeps what follows its last
 * user message, as the app reads it. Descendant sessions belong to this turn and are kept whole.
 */
export function fromPrompt(
  transcript: ReturnType<typeof project>,
  rootSessionID: string,
  promptMessageID: string | undefined,
): ReturnType<typeof project> {
  const root = (message: unknown) => {
    const sessionID = readRecord(message)?.sessionID
    return sessionID === undefined || sessionID === rootSessionID
  }
  const start = promptMessageID
    ? transcript.messages.findIndex((message) => message.id === promptMessageID)
    : transcript.messages.findLastIndex((message) => root(message) && readRecord(message)?.role === "user")
  const kept = transcript.messages.filter((message, index) => !root(message) || (start >= 0 && index >= start))
  if (kept.length === transcript.messages.length) return transcript
  return {
    messages: kept,
    parts: Object.fromEntries(kept.map((message) => [message.id, transcript.parts[message.id] ?? []])),
  }
}

// A run's thread past this goes without its oldest messages; see `withinBudget`.
const ACTIVITY_LIMIT = 8 * 1024 * 1024

/**
 * A run's thread at most `limit` long. Every snapshot, vote and reply answer carries both runs'
 * threads, and past the daemon's limit the window could not load the battle, vote on it or reply to it.
 * Images and large tool fields already go as previews, so only an extreme turn comes near this. It
 * keeps the prompt and the newest messages, and counts the ones it left out in `activityOmitted` for
 * the pane to say so.
 */
export function withinBudget(
  transcript: ReturnType<typeof project>,
  promptMessageID: string | undefined,
  limit = ACTIVITY_LIMIT,
): ReturnType<typeof project> & { readonly activityOmitted?: number } {
  const sizes = transcript.messages.map(
    (message) => JSON.stringify(message).length + JSON.stringify(transcript.parts[message.id] ?? []).length,
  )
  let total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= limit) return transcript
  const omitted = new Set<string>()
  transcript.messages.forEach((message, index) => {
    if (total <= limit || message.id === promptMessageID) return
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
export function wholePart(transcript: readonly unknown[], partID: string): unknown {
  for (const value of transcript) {
    const parts = readRecord(value)?.parts
    if (!Array.isArray(parts)) continue
    const part = parts.find((item: unknown) => readRecord(item)?.id === partID)
    if (part === undefined) continue
    const properties = readRecord(
      readRecord(ArenaPrivacy.event({ type: "message.part.updated", properties: { part } }))?.properties,
    )
    return properties?.part ? withoutAttachmentData(properties.part) : null
  }
  return null
}

export * as ArenaTranscript from "./transcript"
