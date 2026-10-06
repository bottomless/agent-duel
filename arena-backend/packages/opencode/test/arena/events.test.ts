import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import { GlobalBus } from "@/bus/global"
import { externalToolOutput, Recorder } from "@/arena/events"
import { Store } from "@/arena/mongo"
import { connectLocalStore } from "@/arena/local-store"
import { registry } from "@/arena/runtime"
import { Worktree } from "@/worktree"
import { tmpdir } from "../fixture/fixture"

function store(value: object): Store {
  return Object.assign(Object.create(Store.prototype), value)
}

describe("ArenaEvents", () => {
  test("publishes activity for coalesced tool progress before transcript persistence", async () => {
    await using directory = await tmpdir()
    const arena = await connectLocalStore({ directory: directory.path })
    const old = new Date("2026-01-01T00:00:00Z")
    await arena.db.collection<{ _id: string; lastEventAt: Date }>("runs").insertOne({
      _id: "progress-run",
      lastEventAt: old,
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "progress-turn",
      runID: "progress-run",
      rootSessionID: "progress-session",
      directory: directory.path,
      assignment: {
        runID: "progress-run",
        rootSessionID: "progress-session",
        scopeID: "progress-turn",
        assignmentID: "progress-assignment",
        telemetry: true,
      },
    }
    let changes = 0
    const off = arena.onChange(() => {
      changes++
    })
    try {
      await recorder.register(binding)
      const before = Date.now()
      GlobalBus.emit("event", {
        directory: directory.path,
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              id: "progress-part",
              messageID: "progress-message",
              sessionID: binding.rootSessionID,
              type: "tool",
              tool: "bash",
              callID: "progress-call",
              state: {
                status: "running",
                input: { command: "sleep 1" },
                title: "Still working",
                time: { start: before },
                metadata: { output: "progress" },
              },
            },
          },
        },
      })
      await recorder.queues.get(binding.turnID)
      const run = await arena.run(binding.runID)
      expect(run?.lastEventAt?.getTime()).toBeGreaterThanOrEqual(before)
      expect(run?.firstToolAt?.getTime()).toBe(before)
      // The run's first tool time, then its activity.
      expect(changes).toBe(2)
      expect(await arena.rawEvents.find({ runID: binding.runID }).toArray()).toEqual([])
      await recorder.flush(binding.turnID)
      expect(await arena.rawEvents.find({ runID: binding.runID }).toArray()).toHaveLength(1)
    } finally {
      off()
      recorder.unregister(binding.runID)
      recorder.close()
      await arena.close()
    }
  })

  test("streams only approved OpenCode truncation files into a bounded evidence prefix", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "tool_example")
    const content = "0123456789"
    await Bun.write(file, content)

    const output = await externalToolOutput(file, directory.path, 4)
    expect(output?.data.toString()).toBe("0123")
    expect(output?.originalSize).toBe(10)
    expect(output?.contentHash).toBe(createHash("sha256").update(content).digest("hex"))
    expect(await externalToolOutput(path.join(directory.path, "untrusted"), directory.path, 4)).toBeUndefined()
  })

  test("does not expose a run binding before its sequence counters are initialized", async () => {
    const initialized = Promise.withResolvers<null>()
    const events: { sequence: number }[] = []
    const arena = store({
      events: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: () => initialized.promise }) }),
        }),
      },
      rawEvents: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      storeArtifact: async (input: { data: Uint8Array }) => ({
        originalSize: input.data.byteLength,
        storedSize: input.data.byteLength,
        truncated: false,
      }),
      saveEvent: async (event: { sequence: number }) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: unknown) => event,
      runs: { updateOne: async () => ({ acknowledged: true }) },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn",
      runID: "run-a",
      rootSessionID: "session-a",
      directory: "/worktree-a",
      assignment: {
        runID: "run-a",
        rootSessionID: "session-a",
        scopeID: "turn-a",
        assignmentID: "assignment-a",
        telemetry: true,
      },
    }

    const registering = recorder.register(binding)
    await Promise.resolve()
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: { type: Worktree.Event.Ready.type, properties: { name: "during-registration" } },
    })
    initialized.resolve(null)
    await registering

    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: { type: Worktree.Event.Ready.type, properties: { name: "after-registration" } },
    })
    await recorder.flush(binding.turnID)
    registry.assign(binding.rootSessionID, binding.assignment)
    recorder.unregister(binding.runID)
    recorder.close()

    expect(events.map((event) => event.sequence)).toEqual([0])
    expect(recorder.bySession.has(binding.rootSessionID)).toBe(false)
    expect(recorder.byDirectory.has(binding.directory)).toBe(false)
    expect(registry.assignments.has(binding.rootSessionID)).toBe(false)
  })

  test("flush follows work appended while the current queue is draining", async () => {
    const arena = store({})
    const recorder = new Recorder(arena)
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const appended = Promise.withResolvers<void>()
    recorder.queues.set(
      "turn",
      first.promise.then(() => {
        recorder.queues.set("turn", second.promise)
        appended.resolve()
      }),
    )

    let flushed = false
    const flushing = recorder.flush("turn").then(() => {
      flushed = true
    })
    first.resolve()
    await appended.promise
    expect(flushed).toBe(false)
    second.resolve()
    await flushing
    recorder.close()

    expect(flushed).toBe(true)
  })

  test("persists the next event as a gap and makes flush observe a failed write", async () => {
    const saved: Array<{ sequence: number; gap: boolean }> = []
    const raw: Array<{ receiveSequence: number }> = []
    const firstRaw = Promise.withResolvers<void>()
    const firstFailure = Promise.withResolvers<void>()
    let fail = true
    let eventAttempts = 0
    const arena = store({
      events: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      rawEvents: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      storeArtifact: async (input: { data: Uint8Array }) => ({
        originalSize: input.data.byteLength,
        storedSize: input.data.byteLength,
        truncated: false,
      }),
      saveEvent: async (event: { sequence: number; gap: boolean }) => {
        eventAttempts++
        if (fail) {
          fail = false
          firstFailure.resolve()
          throw new Error("injected event write failure")
        }
        saved.push(event)
        return event
      },
      saveRawEvent: async (event: { receiveSequence: number }) => {
        if (event.receiveSequence === 0) await firstRaw.promise
        raw.push(event)
        return event
      },
      runs: { updateOne: async () => ({ acknowledged: true }) },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-fault",
      runID: "run-fault",
      rootSessionID: "session-fault",
      directory: "/worktree-fault",
      assignment: {
        runID: "run-fault",
        rootSessionID: "session-fault",
        scopeID: "turn-fault",
        assignmentID: "assignment-fault",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    const emit = (name: string) =>
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: { type: Worktree.Event.Ready.type, properties: { name } },
      })

    emit("lost")
    await firstFailure.promise
    emit("gap-marker")
    await Promise.resolve()
    expect(eventAttempts).toBe(1)
    firstRaw.resolve()
    await expect(recorder.flush(binding.turnID)).rejects.toThrow("Arena event persistence failed for 1 write")

    expect(saved.map((event) => ({ sequence: event.sequence, gap: event.gap }))).toEqual([{ sequence: 1, gap: true }])
    expect(raw.map((event) => event.receiveSequence)).toEqual([0, 1])
    expect(recorder.gaps.has(binding.turnID)).toBe(false)
    expect(recorder.failures.has(binding.turnID)).toBe(false)

    emit("recovered")
    await recorder.flush(binding.turnID)
    expect(saved.map((event) => ({ sequence: event.sequence, gap: event.gap }))).toEqual([
      { sequence: 1, gap: true },
      { sequence: 2, gap: false },
    ])

    recorder.unregister(binding.runID)
    recorder.close()
  })

  test("coalesces streamed message deltas into the persisted part update", async () => {
    const events: Array<{ type: string; coalesced: boolean; snapshotKey?: string }> = []
    const rawEvents: Array<{ type: string; snapshotKey?: string; storedSize: number; truncated: boolean }> = []
    const artifacts: unknown[] = []
    const runUpdates: unknown[] = []
    const arena = store({
      events: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      rawEvents: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      storeArtifact: async (input: { data: Uint8Array }) => {
        artifacts.push(input)
        return {
          originalSize: input.data.byteLength,
          storedSize: input.data.byteLength,
          truncated: false,
        }
      },
      saveEvent: async (event: (typeof events)[number]) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: (typeof rawEvents)[number]) => {
        rawEvents.push(event)
        return event
      },
      runs: {
        updateOne: async (...input: unknown[]) => {
          runUpdates.push(input)
          return { acknowledged: true, modifiedCount: 1 }
        },
      },
    })
    let controlChanges = 0
    arena.onChange(() => controlChanges++)
    const recorder = new Recorder(arena)
    const liveChanges: unknown[] = []
    recorder.live.subscribe((event) => liveChanges.push(event.change))
    const binding = {
      turnID: "turn-deltas",
      runID: "run-deltas",
      rootSessionID: "session-deltas",
      directory: "/worktree-deltas",
      assignment: {
        runID: "run-deltas",
        rootSessionID: "session-deltas",
        scopeID: "turn-deltas",
        assignmentID: "assignment-deltas",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part",
            messageID: "message",
            sessionID: binding.rootSessionID,
            type: "text",
            text: "",
            time: { start: 1 },
          },
        },
      },
    })
    for (const delta of ["one", "two", "three"]) {
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: binding.rootSessionID,
            messageID: "message",
            partID: "part",
            field: "text",
            delta,
          },
        },
      })
    }
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: binding.rootSessionID,
          part: {
            id: "part",
            messageID: "message",
            sessionID: binding.rootSessionID,
            type: "text",
            text: "onetwothree",
          },
        },
      },
    })

    await recorder.flush(binding.turnID)
    recorder.unregister(binding.runID)
    recorder.close()

    expect(events.map((event) => event.type)).toEqual(["message.part.updated"])
    expect(rawEvents.map((event) => event.type)).toEqual(["message.part.updated"])
    expect(events[0]).toMatchObject({ coalesced: true, snapshotKey: expect.any(String) })
    expect(rawEvents[0]).toMatchObject({ snapshotKey: expect.any(String), storedSize: 0, truncated: true })
    expect(artifacts).toHaveLength(0)
    // Initial part activity and first-token timing are separate writes; later deltas stay coalesced.
    expect(runUpdates).toHaveLength(2)
    expect(controlChanges).toBe(2)
    expect(liveChanges.slice(1, 4)).toEqual([
      { kind: "text", runId: binding.runID, messageId: "message", partId: "part", offset: 0, text: "one" },
      { kind: "text", runId: binding.runID, messageId: "message", partId: "part", offset: 3, text: "two" },
      { kind: "text", runId: binding.runID, messageId: "message", partId: "part", offset: 6, text: "three" },
    ])
  })

  test("blinds raw event artifacts before writing them", async () => {
    process.env.OPENCODE_ARENA = "1"
    const artifacts: string[] = []
    const events: Array<{ payload: Readonly<Record<string, unknown>> }> = []
    const arena = store({
      events: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      rawEvents: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      storeArtifact: async (input: { data: Uint8Array }) => {
        artifacts.push(new TextDecoder().decode(input.data))
        return { originalSize: input.data.byteLength, storedSize: input.data.byteLength, truncated: false }
      },
      saveEvent: async (event: (typeof events)[number]) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: unknown) => event,
      runs: { updateOne: async () => ({ acknowledged: true }) },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-private-event",
      runID: "run-private-event",
      rootSessionID: "session-private-event",
      directory: "/worktree-private-event",
      assignment: {
        runID: "run-private-event",
        rootSessionID: "session-private-event",
        scopeID: "turn-private-event",
        assignmentID: "assignment-private-event",
        telemetry: true,
      },
    }

    try {
      await recorder.register(binding)
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: {
          type: "session.next.step.ended",
          properties: {
            sessionID: binding.rootSessionID,
            cost: 0.456,
            tokens: {
              total: 15_060,
              input: 13_626,
              output: 1_434,
              reasoning: 811,
              cache: { read: 7_320, write: 0 },
            },
          },
        },
      })
      await recorder.flush(binding.turnID)
    } finally {
      recorder.unregister(binding.runID)
      recorder.close()
      delete process.env.OPENCODE_ARENA
    }

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).not.toContain("13626")
    expect(artifacts[0]).not.toContain("7320")
    expect(artifacts[0]).not.toContain("0.456")
    expect(events[0]?.payload).toMatchObject({
      properties: {
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
  })

  test("does not persist intermediate user diff summaries", async () => {
    const events: Array<{ type: string; sequence: number }> = []
    const rawEvents: Array<{ type: string; receiveSequence: number }> = []
    const artifacts: unknown[] = []
    const runUpdates: unknown[] = []
    const arena = store({
      events: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      rawEvents: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      storeArtifact: async (input: { data: Uint8Array }) => {
        artifacts.push(input)
        return { originalSize: input.data.byteLength, storedSize: input.data.byteLength, truncated: false }
      },
      saveEvent: async (event: (typeof events)[number]) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: (typeof rawEvents)[number]) => {
        rawEvents.push(event)
        return event
      },
      runs: {
        updateOne: async (...input: unknown[]) => {
          runUpdates.push(input)
          return { acknowledged: true }
        },
      },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-summary",
      runID: "run-summary",
      rootSessionID: "session-summary",
      directory: "/worktree-summary",
      assignment: {
        runID: "run-summary",
        rootSessionID: "session-summary",
        scopeID: "turn-summary",
        assignmentID: "assignment-summary",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: {
        type: "message.updated",
        properties: {
          sessionID: binding.rootSessionID,
          info: { id: "user-summary", role: "user", summary: { diffs: [{ file: "large.svg", patch: "large" }] } },
        },
      },
    })
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: {
        type: "sync",
        syncEvent: {
          id: "durable-summary",
          type: "message.updated.1",
          data: {
            sessionID: binding.rootSessionID,
            info: { id: "user-summary", role: "user", summary: { diffs: [] } },
          },
        },
      },
    })
    for (const info of [
      { id: "user-prompt", role: "user" },
      { id: "assistant-summary", role: "assistant", summary: { diffs: [] } },
    ]) {
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: { type: "message.updated", properties: { sessionID: binding.rootSessionID, info } },
      })
    }

    await recorder.flush(binding.turnID)
    recorder.unregister(binding.runID)
    recorder.close()

    expect(events.map((event) => ({ type: event.type, sequence: event.sequence }))).toEqual([
      { type: "message.updated", sequence: 0 },
      { type: "message.updated", sequence: 1 },
    ])
    expect(rawEvents.map((event) => ({ type: event.type, receiveSequence: event.receiveSequence }))).toEqual([
      { type: "message.updated", receiveSequence: 0 },
      { type: "message.updated", receiveSequence: 1 },
    ])
    expect(artifacts).toHaveLength(2)
    expect(runUpdates).toHaveLength(1)
  })

  test("records the model tool-call time before execution is released", async () => {
    const events: unknown[] = []
    const rawEvents: unknown[] = []
    const runUpdates: unknown[][] = []
    const arena = store({
      events: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      rawEvents: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      storeArtifact: async (input: { data: Uint8Array }) => ({
        originalSize: input.data.byteLength,
        storedSize: input.data.byteLength,
        truncated: false,
      }),
      saveEvent: async (event: unknown) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: unknown) => {
        rawEvents.push(event)
        return event
      },
      runs: {
        updateOne: async (...input: unknown[]) => {
          runUpdates.push(input)
          return { acknowledged: true }
        },
      },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-tool-start",
      runID: "run-tool-start",
      rootSessionID: "session-tool-start",
      directory: "/worktree-tool-start",
      assignment: {
        runID: "run-tool-start",
        rootSessionID: "session-tool-start",
        scopeID: "turn-tool-start",
        assignmentID: "assignment-tool-start",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    for (const status of ["running", "completed"] as const) {
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: binding.rootSessionID,
            part: {
              id: "tool-part",
              messageID: "assistant-message",
              sessionID: binding.rootSessionID,
              type: "tool",
              tool: "read",
              state: {
                status,
                input: { filePath: "README.md" },
                time: { start: 1_234, ...(status === "completed" ? { end: 9_999 } : {}) },
                ...(status === "completed" ? { title: "README.md", metadata: {}, output: "content" } : {}),
              },
            },
          },
        },
      })
    }

    await recorder.flush(binding.turnID)
    recorder.unregister(binding.runID)
    recorder.close()

    expect(runUpdates.map((update) => update[1])).toContainEqual(
      expect.objectContaining({ $min: { firstToolAt: new Date(1_234) } }),
    )
    expect(runUpdates.map((update) => update[1])).toContainEqual(expect.objectContaining({ $inc: { toolCount: 1 } }))
    expect(events).toHaveLength(1)
    expect(rawEvents).toHaveLength(1)
  })

  test("coalesces repeated full part snapshots and duplicate sync delivery", async () => {
    const events: Array<{
      type: string
      payload: Readonly<Record<string, unknown>>
      coalesced: boolean
      snapshotKey?: string
    }> = []
    const rawEvents: Array<{ type: string; snapshotKey?: string; storedSize: number; truncated: boolean }> = []
    const artifacts: unknown[] = []
    const arena = store({
      events: { find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }) },
      rawEvents: {
        find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
        findOne: async () =>
          rawEvents.length ? { normalizedEventID: "event-snapshot", durableID: "durable-part" } : null,
      },
      storeArtifact: async (input: { data: Uint8Array }) => {
        artifacts.push(input)
        return { originalSize: input.data.byteLength, storedSize: input.data.byteLength, truncated: false }
      },
      saveEvent: async (event: (typeof events)[number]) => {
        events.push(event)
        return event
      },
      saveRawEvent: async (event: (typeof rawEvents)[number]) => {
        rawEvents.push(event)
        return event
      },
      runs: { updateOne: async () => ({ acknowledged: true }) },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-coalesced",
      runID: "run-coalesced",
      rootSessionID: "session-coalesced",
      directory: "/worktree-coalesced",
      assignment: {
        runID: "run-coalesced",
        rootSessionID: "session-coalesced",
        scopeID: "turn-coalesced",
        assignmentID: "assignment-coalesced",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    for (const text of ["one", "one two", "one two three"]) {
      GlobalBus.emit("event", {
        directory: binding.directory,
        payload: {
          id: "durable-part",
          type: "message.part.updated",
          properties: {
            sessionID: binding.rootSessionID,
            part: { id: "part", messageID: "message", type: "text", text },
          },
        },
      })
    }
    await recorder.flush(binding.turnID)
    recorder.normalizedByDurable.clear()
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: {
        type: "sync",
        syncEvent: {
          id: "durable-part",
          type: "message.part.updated",
          properties: { sessionID: binding.rootSessionID },
        },
      },
    })
    await recorder.flush(binding.turnID)
    recorder.unregister(binding.runID)
    recorder.close()

    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0]?.payload)).toContain("one two three")
    expect(events[0]).toMatchObject({ coalesced: true, snapshotKey: expect.any(String) })
    expect(rawEvents.map((event) => event.type)).toEqual(["message.part.updated"])
    expect(artifacts).toHaveLength(0)
  })

  test("persists a terminal gap marker before flush reports an unrecovered write", async () => {
    const saved: Array<{
      sequence: number
      gap: boolean
      type: string
      payload: Readonly<Record<string, unknown>>
    }> = []
    const raw: Array<{ receiveSequence: number }> = []
    let fail = true
    const arena = store({
      events: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      rawEvents: {
        find: () => ({
          sort: () => ({ limit: () => ({ next: async () => null }) }),
        }),
      },
      storeArtifact: async (input: { data: Uint8Array }) => ({
        originalSize: input.data.byteLength,
        storedSize: input.data.byteLength,
        truncated: false,
      }),
      saveEvent: async (event: (typeof saved)[number]) => {
        if (fail) {
          fail = false
          throw new Error("injected terminal event write failure")
        }
        saved.push(event)
        return event
      },
      saveRawEvent: async (event: { receiveSequence: number }) => {
        if (event.receiveSequence === 0) throw new Error("injected terminal raw write failure")
        raw.push(event)
        return event
      },
      runs: { updateOne: async () => ({ acknowledged: true }) },
    })
    const recorder = new Recorder(arena)
    const binding = {
      turnID: "turn-terminal-fault",
      runID: "run-terminal-fault",
      rootSessionID: "session-terminal-fault",
      directory: "/worktree-terminal-fault",
      assignment: {
        runID: "run-terminal-fault",
        rootSessionID: "session-terminal-fault",
        scopeID: "turn-terminal-fault",
        assignmentID: "assignment-terminal-fault",
        telemetry: true,
      },
    }
    await recorder.register(binding)
    GlobalBus.emit("event", {
      directory: binding.directory,
      payload: { type: Worktree.Event.Ready.type, properties: { name: "terminal-loss" } },
    })

    await expect(recorder.flush(binding.turnID)).rejects.toThrow("Arena event persistence failed for 2 writes")
    expect(raw).toEqual([])
    expect(
      saved.map((event) => ({
        sequence: event.sequence,
        gap: event.gap,
        type: event.type,
        payload: event.payload,
      })),
    ).toEqual([
      {
        sequence: 1,
        gap: true,
        type: "arena.persistence.gap",
        payload: { failedWrites: 2 },
      },
    ])
    expect(recorder.gaps.has(binding.turnID)).toBe(false)
    expect(recorder.failures.has(binding.turnID)).toBe(false)
    await recorder.flush(binding.turnID)

    recorder.unregister(binding.runID)
    recorder.close()
  })
})
