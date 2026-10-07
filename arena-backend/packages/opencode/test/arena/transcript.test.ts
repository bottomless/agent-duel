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
