import { readRecord, withoutAttachmentData } from "./live"
import { ArenaPrivacy } from "./privacy"

/**
 * Shared by live snapshots and archives so reconnecting preserves descendant activity. Tool results
 * leave out their attachments' data, which the app does not show.
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
        return properties?.part ? [withoutAttachmentData(properties.part)] : []
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

export * as ArenaTranscript from "./transcript"
