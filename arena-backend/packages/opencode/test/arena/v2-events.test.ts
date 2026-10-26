import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { project } from "@/arena/session-runtime/projection"
import { utf16DeltaOffset } from "@/arena/v2-events"

describe("Arena V2 event projection", () => {
  test("keeps reasoning, text, tool, and trailing text IDs aligned with canonical content order", () => {
    const sessionID = Session.ID.make("ses_v2_projection")
    const messageID = "msg_v2_projection"
    const message = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: messageID,
      type: "assistant",
      agent: "build",
      model: { providerID: "arena", id: "contestant" },
      content: [
        { type: "reasoning", text: "private reasoning", time: { created: 1, completed: 2 } },
        { type: "text", text: "before tool" },
        {
          type: "tool",
          id: "call-native-bridge",
          name: "edit",
          state: {
            status: "completed",
            input: { path: "bridge-marker.txt" },
            content: [{ type: "text", text: "Edited bridge-marker.txt" }],
            metadata: {},
          },
          time: { created: 3, ran: 4, completed: 5 },
        },
        { type: "text", text: "after tool" },
      ],
      time: { created: 1, completed: 6 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const entry = project([message], sessionID)[0]
    expect(entry?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool", "text"])
    expect(entry?.parts.map((part) => part.id)).toEqual([
      `prt_${messageID.slice(4)}_0`,
      `prt_${messageID.slice(4)}_1`,
      `prt_${messageID.slice(4)}_2`,
      `prt_${messageID.slice(4)}_3`,
    ])
    expect(new Set(entry?.parts.map((part) => part.id)).size).toBe(4)
    const tool = entry?.parts.find((part) => part.type === "tool")
    expect(tool).toMatchObject({
      type: "tool",
      callID: "call-native-bridge",
      state: { status: "completed", output: "Edited bridge-marker.txt" },
    })
    expect(utf16DeltaOffset("before 😀", "😀")).toBe(7)
  })
})
