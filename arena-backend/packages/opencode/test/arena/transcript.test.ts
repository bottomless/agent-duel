import { afterEach, beforeEach, expect, test } from "bun:test"
import { fromPrompt, project, wholePart, withinBudget } from "../../src/arena/transcript"

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

// A contestant session is a fork of the chat: two earlier turns, then this turn's prompt and work.
function forkedRun() {
  const message = (id: string, sessionID: string, role: string, created: number) => ({
    info: { id, sessionID, role, time: { created } },
    parts: [{ id: `part-${id}`, messageID: id, sessionID, type: "text", text: id }],
  })
  return project([
    message("turn-1-prompt", "root", "user", 1),
    message("turn-1-reply", "root", "assistant", 2),
    message("turn-2-prompt", "root", "user", 3),
    message("turn-2-reply", "root", "assistant", 4),
    message("prompt", "root", "user", 5),
    message("child-work", "child", "assistant", 6),
    message("reply", "root", "assistant", 7),
  ])
}

test("keeps a run's transcript from its prompt on, with its descendants", () => {
  const result = fromPrompt(forkedRun(), "root", "prompt")
  expect(result.messages.map((message) => message.id)).toEqual(["prompt", "child-work", "reply"])
  expect(Object.keys(result.parts)).toEqual(["prompt", "child-work", "reply"])
  expect(JSON.stringify(result)).not.toContain("turn-1")
})

test("keeps none of the forked chat before the prompt is written", () => {
  const result = fromPrompt(forkedRun(), "root", "not-written-yet")
  expect(result.messages.map((message) => message.id)).toEqual(["child-work"])
})

test("keeps a run without a boundary from its last user message, as the app reads it", () => {
  const result = fromPrompt(forkedRun(), "root", undefined)
  expect(result.messages.map((message) => message.id)).toEqual(["prompt", "child-work", "reply"])
})

test("sends a tool call's large fields as their start and end, and the whole part on request", () => {
  const big = `first line\n${"x".repeat(20_000)}\nlast line`
  const message = {
    info: { id: "reply", sessionID: "root", role: "assistant", time: { created: 1 } },
    parts: [
      {
        id: "call",
        messageID: "reply",
        sessionID: "root",
        type: "tool",
        tool: "write",
        callID: "call-1",
        state: {
          status: "completed",
          input: { filePath: "big.txt", content: big },
          output: big,
          metadata: { output: big, sessionId: "child", answers: [["Yes"]] },
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
  const state = project([message]).parts.reply[0].state as Record<string, any>

  expect(state.previewed).toEqual(["output", "input.content", "metadata.output"])
  for (const value of [state.output, state.input.content, state.metadata.output]) {
    expect(value.length).toBeLessThan(5_000)
    expect(value.startsWith("first line")).toBe(true)
    expect(value.endsWith("last line")).toBe(true)
    expect(value).toContain("more characters")
  }
  expect(state.input.filePath).toBe("big.txt")
  expect(state.metadata).toMatchObject({ sessionId: "child", answers: [["Yes"]] })

  const whole = wholePart([message], "call") as Record<string, any>
  expect(whole.state.output).toBe(big)
  expect(whole.state.input.content).toBe(big)
  expect(whole.state.previewed).toBeUndefined()
  expect(wholePart([message], "missing")).toBeNull()
})

test("sends a pasted image without its data, and the whole part on request", () => {
  const photo = `data:image/png;base64,${"A".repeat(560_000)}`
  const icon = `data:image/png;base64,${"A".repeat(100)}`
  const filePart = (id: string, url: string) => ({
    id,
    messageID: "steer",
    sessionID: "root",
    type: "file",
    mime: "image/png",
    filename: `${id}.png`,
    url,
  })
  const message = {
    info: { id: "steer", sessionID: "root", role: "user", time: { created: 1 } },
    parts: [
      filePart("photo", photo),
      filePart("icon", icon),
      filePart("archived", "arena-image:sha256:0123"),
    ],
  }
  const [shownPhoto, shownIcon, shownArchived] = project([message]).parts.steer as Record<string, unknown>[]

  expect(shownPhoto).toMatchObject({ type: "file", mime: "image/png", filename: "photo.png", url: "", previewed: ["url"] })
  expect(shownIcon).toMatchObject({ url: icon })
  expect(shownIcon?.previewed).toBeUndefined()
  expect(shownArchived).toMatchObject({ url: "", previewed: ["url"] })
  expect(wholePart([message], "photo")).toMatchObject({ url: photo })
})

test("leaves out a thread's oldest messages past its limit, keeping the prompt", () => {
  const message = (id: string, role: string, created: number) => ({
    info: { id, sessionID: "root", role, time: { created } },
    parts: [{ id: `${id}-text`, messageID: id, sessionID: "root", type: "text", text: "x".repeat(1_000) }],
  })
  const thread = project([
    message("prompt", "user", 1),
    message("first", "assistant", 2),
    message("steer", "user", 3),
    message("second", "assistant", 4),
  ])

  expect(withinBudget(thread, "root", "prompt", 10_000)).toBe(thread)
  // Each message is a little over 1 KB, so two of them fit.
  const kept = withinBudget(thread, "root", "prompt", 3_000)
  expect(kept.messages.map((item) => item.id)).toEqual(["prompt", "second"])
  expect(Object.keys(kept.parts)).toEqual(["prompt", "second"])
  expect(kept.activityOmitted).toBe(2)
  // A run without a recorded boundary keeps its first user message, where `fromPrompt` started it.
  expect(withinBudget(thread, "root", undefined, 3_000).messages.map((item) => item.id)).toEqual([
    "prompt",
    "second",
  ])
})

test("keeps the messages a trimmed pane still acts on: a waiting tool call and the latest task list", () => {
  const filler = "x".repeat(1_000)
  const message = (id: string, role: string, created: number, parts: Record<string, unknown>[]) => ({
    info: { id, sessionID: "root", role, time: { created } },
    parts: parts.map((part, index) => ({ id: `${id}-${index}`, messageID: id, sessionID: "root", ...part })),
  })
  const tool = (tool: string, status: string) => ({
    type: "tool",
    tool,
    callID: `${tool}-call`,
    state: { status, input: {}, time: { start: 1 } },
  })
  const thread = project([
    message("prompt", "user", 1, [{ type: "text", text: "Do it" }]),
    message("plan", "assistant", 2, [tool("todowrite", "completed"), { type: "text", text: filler }]),
    message("asking", "assistant", 3, [tool("bash", "running"), { type: "text", text: filler }]),
    message("old", "assistant", 4, [{ type: "text", text: filler }]),
    message("latest", "assistant", 5, [{ type: "text", text: filler }]),
  ])

  const kept = withinBudget(thread, "root", "prompt", 2_000)
  expect(kept.messages.map((item) => item.id)).toEqual(["prompt", "plan", "asking", "latest"])
  expect(kept.activityOmitted).toBe(1)
})

test("keeps what a trimmed pane's subagent cards read: the task call and each session's newest message", () => {
  const filler = "x".repeat(1_000)
  const message = (id: string, sessionID: string, role: string, created: number, parts: Record<string, unknown>[]) => ({
    info: { id, sessionID, role, time: { created } },
    parts: parts.map((part, index) => ({ id: `${id}-${index}`, messageID: id, sessionID, ...part })),
  })
  const thread = project([
    message("prompt", "root", "user", 1, [{ type: "text", text: "Do it" }]),
    message("delegate", "root", "assistant", 2, [
      { type: "tool", tool: "task", callID: "task-1", state: { status: "completed", input: {}, metadata: { sessionId: "child" } } },
      { type: "text", text: filler },
    ]),
    message("child-early", "child", "assistant", 3, [{ type: "text", text: filler }]),
    message("child-done", "child", "assistant", 4, [{ type: "text", text: filler }]),
    message("root-old", "root", "assistant", 5, [{ type: "text", text: filler }]),
    message("root-latest", "root", "assistant", 6, [{ type: "text", text: filler }]),
  ])

  const kept = withinBudget(thread, "root", "prompt", 2_000)
  expect(kept.messages.map((item) => item.id)).toEqual(["prompt", "delegate", "child-done", "root-latest"])
  expect(kept.activityOmitted).toBe(2)
})

test("keeps none of the forked chat for a run that has not written its prompt", () => {
  expect(fromPrompt(forkedRun(), "root", null).messages.map((message) => message.id)).toEqual(["child-work"])
})
