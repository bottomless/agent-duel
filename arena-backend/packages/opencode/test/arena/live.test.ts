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
  test("captures token-only output for a late baseline without persisting token events", () => {
    const live = new ArenaLive()
    const binding = { runID: "run", turnID: "turn", rootSessionID: "session" }
    const received: unknown[] = []
    const off = live.subscribe((event) => received.push(event.change))
    live.capture(binding, {
      type: "message.part.updated",
      properties: {
        part: { id: "p", messageID: "m", sessionID: "session", type: "text", text: "", time: { start: 1 } },
      },
    })
    live.capture(binding, {
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "m", partID: "p", field: "text", delta: "hello" },
    })
    expect(received[1]).toEqual({ kind: "text", runId: "run", messageId: "m", partId: "p", offset: 0, text: "hello" })
    expect(live.partsFor("run")[0]).toMatchObject({ text: "hello" })
    off()
    live.capture(binding, {
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "m", partID: "p", field: "text", delta: " world" },
    })
    expect(live.partsFor("run")[0]).toMatchObject({ text: "hello world" })
    live.release("run")
    expect(live.partsFor("run")).toEqual([])
  })
  test("applies the existing tool blinding rules and publishes part removal", () => {
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
          sessionID: "root",
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
        sessionID: "root",
        messageID: "m",
        partID: "p",
      },
    })
    expect(values[1]).toEqual({ kind: "remove_part", runId: "run", messageId: "m", partId: "p" })
  })
  test("redacts identities and excludes child transcripts", () => {
    const live = new ArenaLive()
    const values: unknown[] = []
    live.subscribe((event) => values.push(event.change))
    const binding = { runID: "run", turnID: "turn", rootSessionID: "root" }
    live.capture(binding, {
      type: "message.updated",
      properties: { info: { id: "m", sessionID: "root", providerID: "secret", modelID: "secret" } },
    })
    live.capture(binding, { type: "message.updated", properties: { info: { id: "child", sessionID: "child" } } })
    expect(values).toEqual([{ kind: "message", runId: "run", message: { id: "m", sessionID: "root" } }])
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
})
