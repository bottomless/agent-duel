import { afterEach, beforeEach, expect, test } from "bun:test"
import { project } from "../../src/arena/transcript"

const original = process.env.OPENCODE_ARENA
beforeEach(() => {
  process.env.OPENCODE_ARENA = "1"
})
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = original
})

test("interleaves parent and descendant transcripts and preserves blinded tool details", () => {
  const message = (id: string, sessionID: string, created: number) => ({
    info: { id, sessionID, role: "assistant", time: { created }, modelID: "secret-model" },
    parts: [
      {
        id: `part-${id}`,
        messageID: id,
        sessionID,
        type: "tool",
        tool: "bash",
        callID: "secret-call",
        state: { status: "completed", input: { command: "pwd" }, output: "/repo" },
      },
    ],
  })
  const result = project([
    message("parent-before", "root", 1),
    message("parent-after", "root", 3),
    message("child-work", "child", 2),
  ])
  expect(result.messages.map((message) => message.id)).toEqual(["parent-before", "child-work", "parent-after"])
  expect(result.parts["child-work"][0]).toMatchObject({
    sessionID: "child",
    tool: "bash",
    state: { input: { command: "pwd" } },
  })
  expect(JSON.stringify(result)).not.toContain("secret")
})

test("leaves out a tool result's attachment data and keeps the prompt's images", () => {
  const screenshot = `data:image/png;base64,${"A".repeat(4096)}`
  const pasted = "data:image/png;base64,iVBORw0KGgo="
  const result = project([
    {
      info: { id: "prompt", sessionID: "root", role: "user", time: { created: 1 } },
      parts: [
        { id: "text", messageID: "prompt", sessionID: "root", type: "text", text: "Match this" },
        { id: "image", messageID: "prompt", sessionID: "root", type: "file", mime: "image/png", url: pasted },
      ],
    },
    {
      info: { id: "reply", sessionID: "root", role: "assistant", time: { created: 2 } },
      parts: [
        {
          id: "read",
          messageID: "reply",
          sessionID: "root",
          type: "tool",
          tool: "read",
          callID: "call",
          state: {
            status: "completed",
            input: { filePath: "shot.png" },
            output: "Image read successfully",
            title: "shot.png",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments: [{ type: "file", mime: "image/png", url: screenshot }],
          },
        },
      ],
    },
  ])
  expect(result.parts.prompt[1]).toMatchObject({ type: "file", url: pasted })
  expect(result.parts.reply[0]).toMatchObject({
    state: { output: "Image read successfully", attachments: [{ type: "file", mime: "image/png" }] },
  })
  expect(JSON.stringify(result)).not.toContain(screenshot)
})
