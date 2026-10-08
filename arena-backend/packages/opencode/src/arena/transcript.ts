import { readRecord } from "./live"
import { ArenaPrivacy } from "./privacy"

/** Shared by live snapshots and archives so reconnecting preserves descendant activity. */
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
        return properties?.part ? [properties.part] : []
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

export * as ArenaTranscript from "./transcript"
