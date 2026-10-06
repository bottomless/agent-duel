import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { ArenaLive } from "../../src/arena/live"
import { Snapshot } from "../../src/arena/schema"
import { createArenaStream, reconcileBootstrap, type Frame } from "../../src/arena/stream"
const original = process.env.OPENCODE_ARENA
beforeEach(() => {
  process.env.OPENCODE_ARENA = "1"
})
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = original
})
const binding = { runID: "a", turnID: "turn", rootSessionID: "a" }
function fixture() {
  return Schema.decodeUnknownSync(Snapshot)({
    chat: {
      id: "chat",
      status: "battle_active",
      canonicalSessionID: "canonical",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    turn: {
      id: "turn",
      index: 1,
      state: "running",
      prompt: "hello",
      baseSHA: "sha",
      comparisonState: "pending",
      canVote: false,
      canRetryResolution: false,
      revealed: false,
      createdAt: "now",
      updatedAt: "now",
    },
    environment: {},
    history: [],
    events: [],
    runs: [
      {
        id: "a",
        side: "a",
        sessionID: "a",
        descendantSessionIDs: [],
        worktree: "/tmp/a",
        worktreeName: "a",
        worktreeActive: true,
        runState: "pending",
        durationMs: null,
        selectable: false,
        applicable: false,
        messages: [{ id: "m", sessionID: "a", role: "assistant" }],
        parts: { m: [{ id: "p", messageID: "m", sessionID: "a", type: "text", text: "" }] },
      },
    ],
  })
}
function start(live: ArenaLive) {
  live.capture(binding, {
    type: "message.part.updated",
    properties: { part: { id: "p", messageID: "m", sessionID: "a", type: "text", text: "", time: { start: 1 } } },
  })
}
function delta(live: ArenaLive, text: string) {
  live.capture(binding, {
    type: "message.part.delta",
    properties: { sessionID: "a", messageID: "m", partID: "p", field: "text", delta: text },
  })
}
test("reconciles snapshot writes with ongoing tokens exactly once", async () => {
  const live = new ArenaLive()
  start(live)
  let begin!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const frames: Frame[] = []
  let reads = 0
  let listeners = 0
  const stream = createArenaStream({
    live,
    read: (full) =>
      Effect.promise(async () => {
        if (full) {
          reads++
          begin()
          await ready
        }
        return fixture()
      }),
    discover: Effect.void,
    onChange: () => {
      listeners++
      return () => {
        listeners--
      }
    },
  })
  const running = Effect.runPromise(
    stream.pipe(
      Stream.take(2),
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          frames.push(frame)
          if (frame.kind === "snapshot") {
            delta(live, "!")
            delta(live, "!")
          }
        }),
      ),
    ),
  )
  await started
  delta(live, "hello")
  release()
  await running
  expect(frames[0]).toMatchObject({ kind: "snapshot", snapshot: { runs: [{ parts: { m: [{ text: "hello" }] } }] } })
  expect(frames[1]).toEqual({
    kind: "changes",
    changes: [{ kind: "text", runId: "a", messageId: "m", partId: "p", offset: 5, text: "!!" }],
  })
  expect(reads).toBe(1)
  expect(listeners).toBe(0)
})
test("late baseline includes 5 MB unfinished text without replay", () => {
  const live = new ArenaLive()
  start(live)
  const text = "x".repeat(5 * 1024 * 1024)
  delta(live, text)
  expect(reconcileBootstrap(fixture(), [], live).runs[0].parts?.m[0]).toMatchObject({ text })
})

test("publishes renewed activity and keeps it in a reconnect snapshot", async () => {
  const live = new ArenaLive()
  const old = fixture()
  old.runs[0]!.lastEventAt = "2026-09-24T10:00:00.000Z"
  const fresh = fixture()
  fresh.runs[0]!.lastEventAt = "2026-09-24T10:02:00.000Z"
  let current = old
  let notify = () => {}
  const source = {
    live,
    read: () => Effect.sync(() => current),
    discover: Effect.void,
    onChange: (listener: () => void) => {
      notify = listener
      return () => {}
    },
  }
  const frames: Frame[] = []
  await Effect.runPromise(
    createArenaStream(source).pipe(
      Stream.take(2),
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          frames.push(frame)
          if (frame.kind === "snapshot") {
            current = fresh
            notify()
          }
        }),
      ),
      Effect.timeout("2 seconds"),
    ),
  )
  expect(frames[1]).toMatchObject({
    kind: "changes",
    changes: [
      {
        kind: "state",
        snapshot: {
          runs: [{ lastEventAt: fresh.runs[0]!.lastEventAt }],
        },
      },
    ],
  })
  const reconnected = await Effect.runPromise(createArenaStream(source).pipe(Stream.take(1), Stream.runCollect))
  expect(Array.from(reconnected)[0]).toMatchObject({
    kind: "snapshot",
    snapshot: {
      runs: [{ lastEventAt: fresh.runs[0]!.lastEventAt }],
    },
  })
})
test("bootstrap deletion removes stale persisted parts", () => {
  const snapshot = reconcileBootstrap(
    fixture(),
    [
      { kind: "part", runId: "a", part: { id: "p", messageID: "m", sessionID: "a", text: "final" } },
      { kind: "remove_part", runId: "a", messageId: "m", partId: "p" },
    ],
    new ArenaLive(),
  )
  expect(snapshot.runs[0].parts?.m).toEqual([])
})

test("slow control reads do not hold token batches", async () => {
  const live = new ArenaLive()
  start(live)
  const stream = createArenaStream({
    live,
    read: (full) =>
      full ? Effect.succeed(fixture()) : Effect.sync(() => delta(live, "fresh")).pipe(Effect.andThen(Effect.never)),
    discover: Effect.void,
    onChange: () => () => {},
  })
  const frames = await Effect.runPromise(stream.pipe(Stream.take(2), Stream.runCollect, Effect.timeout("500 millis")))
  expect(Array.from(frames)[1]).toEqual({
    kind: "changes",
    changes: [{ kind: "text", runId: "a", messageId: "m", partId: "p", offset: 0, text: "fresh" }],
  })
})

test("publishes a new contestant session before its live messages", async () => {
  const live = new ArenaLive()
  const initial = fixture()
  const next = fixture()
  next.runs[0] = {
    ...next.runs[0],
    sessionID: "new-session",
    messages: [{ id: "m", sessionID: "new-session", role: "assistant" }],
    parts: {},
  }
  let reads = 0
  const frames = await Effect.runPromise(
    createArenaStream({
      live,
      read: (full) =>
        Effect.promise(async () => {
          if (full) return reads++ === 0 ? initial : next
          const binding = { runID: "a", turnID: "turn", rootSessionID: "new-session" }
          live.capture(binding, {
            type: "message.updated",
            properties: { info: { id: "m", sessionID: "new-session", role: "assistant" } },
          })
          live.capture(binding, {
            type: "message.part.updated",
            properties: {
              part: { id: "p", messageID: "m", sessionID: "new-session", type: "text", text: "new text" },
            },
          })
          // The control read overlaps the first live events from the newly prepared session.
          await new Promise((resolve) => setTimeout(resolve, 200))
          return next
        }),
      discover: Effect.void,
      onChange: () => () => {},
    }).pipe(Stream.take(2), Stream.runCollect, Effect.timeout("1 second")),
  )
  expect(Array.from(frames)[1]).toMatchObject({
    kind: "snapshot",
    snapshot: { runs: [{ sessionID: "new-session", parts: { m: [{ text: "new text" }] } }] },
  })
})

test("terminal control updates do not reread the transcript", async () => {
  const live = new ArenaLive()
  let reads = 0
  const full = fixture()
  const state = {
    ...full,
    runs: full.runs.map(({ messages: _messages, parts: _parts, ...run }) => ({
      ...run,
      runState: "complete" as const,
    })),
  }
  const frames = await Effect.runPromise(
    createArenaStream({
      live,
      read: (hydrate) => {
        if (hydrate) reads++
        return Effect.succeed(hydrate ? full : state)
      },
      discover: Effect.void,
      onChange: () => () => {},
    }).pipe(Stream.take(2), Stream.runCollect, Effect.timeout("500 millis")),
  )
  expect(reads).toBe(1)
  expect(Array.from(frames)[1]).toMatchObject({
    kind: "changes",
    changes: [{ kind: "state", snapshot: { runs: [{ runState: "complete" }] } }],
  })
})

test("bounds bootstrap event buffering and releases observers on overflow", async () => {
  const live = new ArenaLive()
  let begin!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let observers = 0
  const stream = createArenaStream({
    live,
    read: () =>
      Effect.promise(async () => {
        begin()
        await ready
        return fixture()
      }),
    discover: Effect.void,
    onChange: () => {
      observers++
      return () => {
        observers--
      }
    },
  })
  const running = Effect.runPromise(stream.pipe(Stream.runDrain))
  const failure = running.catch((error: unknown) => error)
  await started
  for (let index = 0; index < 260; index++)
    live.capture(binding, {
      type: "message.updated",
      properties: { info: { id: "message-" + index, sessionID: "a" } },
    })
  release()
  const result = await failure
  expect(String(result)).toContain("buffer exceeded")
  expect(observers).toBe(0)
})

test("unchanged service discovery does not periodically reread control state", async () => {
  const live = new ArenaLive()
  let fullReads = 0
  let controlReads = 0
  let discoveries = 0
  const frames: Frame[] = []
  const stream = createArenaStream({
    live,
    read: (full) =>
      Effect.sync(() => {
        const snapshot = fixture()
        if (full) {
          fullReads++
          return snapshot
        }
        controlReads++
        return { ...snapshot, runs: snapshot.runs.map(({ messages, parts, ...run }) => run) }
      }),
    discover: Effect.sync(() => {
      discoveries++
    }),
    onChange: () => () => {},
  })
  await Effect.runPromise(
    stream.pipe(
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }),
      ),
      Effect.timeout("1200 millis"),
      Effect.exit,
    ),
  )
  expect(discoveries).toBeGreaterThanOrEqual(2)
  expect(fullReads).toBe(1)
  expect(controlReads).toBe(1)
  expect(frames).toHaveLength(1)
  expect(frames[0].kind).toBe("snapshot")
})
