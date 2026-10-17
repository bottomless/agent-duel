import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ArenaLive } from "../../src/arena/live"

const originalArena = process.env.OPENCODE_ARENA
beforeEach(() => {
  process.env.OPENCODE_ARENA = "1"
})
afterEach(() => {
  if (originalArena === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = originalArena
})

describe("Arena live transcript", () => {
  test.each(["session", "child"])(
    "captures %s token-only output for a late baseline without persisting token events",
    (sessionID) => {
      const live = new ArenaLive()
      const binding = { runID: "run", turnID: "turn", rootSessionID: "session" }
      const received: unknown[] = []
      const off = live.subscribe((event) => received.push(event.change))
      live.capture(binding, {
        type: "message.part.updated",
        properties: {
          part: { id: "p", messageID: "m", sessionID, type: "text", text: "", time: { start: 1 } },
        },
      })
      live.capture(binding, {
        type: "message.part.delta",
        properties: { sessionID, messageID: "m", partID: "p", field: "text", delta: "hello" },
      })
      expect(received[1]).toEqual({ kind: "text", runId: "run", messageId: "m", partId: "p", offset: 0, text: "hello" })
      expect(live.partsFor("run")[0]).toMatchObject({ text: "hello" })
      off()
      live.capture(binding, {
        type: "message.part.delta",
        properties: { sessionID, messageID: "m", partID: "p", field: "text", delta: " world" },
      })
      expect(live.partsFor("run")[0]).toMatchObject({ text: "hello world" })
      live.release("run")
      expect(live.partsFor("run")).toEqual([])
    },
  )
  test.each(["root", "child"])("applies %s tool blinding and publishes part removal", (sessionID) => {
    const live = new ArenaLive()
    const values: unknown[] = []
    live.subscribe((event) => values.push(event.change))
    const binding = { runID: "run", turnID: "turn", rootSessionID: "root" }
    live.capture(binding, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p",
          messageID: "m",
          sessionID,
          type: "tool",
          tool: "bash",
          callID: "provider-secret-call",
          providerMetadata: { model: "provider-secret-model" },
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "/repo",
            title: "pwd",
            metadata: { tasks: [{ id: "verify", description: "Verify changes", status: "in_progress" }] },
            time: { start: 1, end: 2 },
          },
        },
      },
    })
    expect(values[0]).toMatchObject({
      kind: "part",
      part: {
        callID: expect.stringMatching(/^call_arena_[a-f0-9]{32}$/),
        state: {
          output: "/repo",
          metadata: { tasks: [{ id: "verify", description: "Verify changes", status: "in_progress" }] },
        },
      },
    })
    expect(JSON.stringify(values)).not.toContain("provider-secret")
    live.capture(binding, {
      type: "message.part.removed",
      properties: {
        sessionID,
        messageID: "m",
        partID: "p",
      },
    })
    expect(values[1]).toEqual({ kind: "remove_part", runId: "run", messageId: "m", partId: "p" })
  })
  test("publishes a tool result without its attachments' data", () => {
    const live = new ArenaLive()
    const values: unknown[] = []
    live.subscribe((event) => values.push(event.change))
    const screenshot = `data:image/png;base64,${"A".repeat(4096)}`
    live.capture(
      { runID: "run", turnID: "turn", rootSessionID: "root" },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            messageID: "m",
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
        },
      },
    )
    expect(values[0]).toMatchObject({
      kind: "part",
      part: { state: { output: "Image read successfully", attachments: [{ type: "file", mime: "image/png" }] } },
    })
    expect(JSON.stringify(values)).not.toContain(screenshot)
  })
  test("redacts identities in both parent and child transcripts", () => {
    const live = new ArenaLive()
    const values: unknown[] = []
    live.subscribe((event) => values.push(event.change))
    const binding = { runID: "run", turnID: "turn", rootSessionID: "root" }
    live.capture(binding, {
      type: "message.updated",
      properties: { info: { id: "m", sessionID: "root", providerID: "secret", modelID: "secret" } },
    })
    live.capture(binding, { type: "message.updated", properties: { info: { id: "child", sessionID: "child" } } })
    expect(values).toEqual([
      { kind: "message", runId: "run", message: { id: "m", sessionID: "root" } },
      { kind: "message", runId: "run", message: { id: "child", sessionID: "child" } },
    ])
  })
  test("refreshes interaction state without forwarding raw permission or question events", () => {
    const live = new ArenaLive()
    const values: unknown[] = []
    let refreshes = 0
    live.subscribe((event) => values.push(event))
    const off = live.onDirty(() => refreshes++)
    const binding = { runID: "run", turnID: "turn", rootSessionID: "root" }
    for (const type of ["permission.asked", "permission.replied", "question.asked", "question.rejected"]) {
      live.capture(binding, {
        type,
        properties: { sessionID: "root", id: "request", providerMetadata: { model: "private-model" } },
      })
    }
    expect(refreshes).toBe(4)
    expect(values).toEqual([])
    off()
    live.capture(binding, { type: "permission.asked", properties: { sessionID: "root", id: "late" } })
    expect(refreshes).toBe(4)
  })

  test("pushes a part with its large fields shortened, as a snapshot sends it", () => {
    const live = new ArenaLive()
    const values: Array<{ kind: string; part?: Record<string, unknown> }> = []
    live.subscribe((event) => values.push(event.change as (typeof values)[number]))
    const binding = { runID: "run", turnID: "turn", rootSessionID: "root" }
    const output = `start\n${"x".repeat(20_000)}\nend`
    const photo = `data:image/png;base64,${"A".repeat(20_000)}`
    live.capture(binding, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "call",
          messageID: "m",
          sessionID: "root",
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: { status: "completed", input: { command: "cat log" }, output, metadata: {}, time: { start: 1, end: 2 } },
        },
      },
    })
    live.capture(binding, {
      type: "message.part.updated",
      properties: {
        part: { id: "photo", messageID: "steer", sessionID: "root", type: "file", mime: "image/png", url: photo },
      },
    })

    const [call, image] = values.map((value) => value.part)
    const state = call?.state as { output: string; previewed: string[] }
    expect(state.previewed).toEqual(["output"])
    expect(state.output.length).toBeLessThan(5_000)
    expect(state.output.startsWith("start")).toBe(true)
    expect(image).toMatchObject({ type: "file", url: "", previewed: ["url"] })
    expect(JSON.stringify(values)).not.toContain("A".repeat(1_000))
  })
})
