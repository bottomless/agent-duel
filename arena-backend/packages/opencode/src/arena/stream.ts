import { Cause, Effect, Queue, Stream } from "effect"
import type { ArenaSchema } from "./schema"
import { readRecord, type ArenaLive, type LiveChange, type LiveNotification } from "./live"

export type Frame =
  | { kind: "snapshot"; snapshot: ArenaSchema.Snapshot }
  | { kind: "changes"; changes: Array<LiveChange | { kind: "state"; snapshot: ArenaSchema.Snapshot }> }
  | { kind: "reset"; reason: string }

interface Source {
  live: ArenaLive
  read: (full: boolean) => Effect.Effect<ArenaSchema.Snapshot, Error>
  discover: Effect.Effect<void, Error>
  onChange: (listener: () => void) => () => void
}

function key(change: LiveChange): string {
  switch (change.kind) {
    case "message":
      return change.runId + "/m/" + change.message.id
    case "part":
      return change.runId + "/p/" + change.part.id
    case "text":
      return change.runId + "/p/" + change.partId
    case "remove_message":
      return change.runId + "/m/" + change.messageId
    case "remove_part":
      return change.runId + "/p/" + change.partId
  }
}

export function reconcileBootstrap(
  snapshot: ArenaSchema.Snapshot,
  changes: Iterable<LiveChange>,
  live: ArenaLive,
): ArenaSchema.Snapshot {
  const selected = [...changes]
  for (const run of snapshot.runs)
    for (const part of live.partsFor(run.id)) selected.push({ kind: "part", runId: run.id, part })
  const runs = snapshot.runs.map((run) => {
    let messages = [...(run.messages ?? [])]
    const parts: Record<string, readonly unknown[]> = { ...(run.parts ?? {}) }
    function put(items: readonly unknown[], item: Record<string, unknown>): unknown[] {
      const index = items.findIndex((value) => readRecord(value)?.id === item.id)
      const next = [...items]
      if (index < 0) next.push(item)
      else next[index] = item
      return next
    }
    for (const change of selected) {
      if (change.runId !== run.id) continue
      if (change.kind === "message") messages = put(messages, change.message)
      else if (change.kind === "part")
        parts[change.part.messageID] = put(parts[change.part.messageID] ?? [], change.part)
      else if (change.kind === "remove_message") {
        messages = messages.filter((item) => readRecord(item)?.id !== change.messageId)
        delete parts[change.messageId]
      } else if (change.kind === "remove_part")
        parts[change.messageId] = (parts[change.messageId] ?? []).filter(
          (item) => readRecord(item)?.id !== change.partId,
        )
    }
    return { ...run, messages, parts }
  })
  return { ...snapshot, runs, events: [] }
}

function lifecycle(snapshot: ArenaSchema.Snapshot) {
  return JSON.stringify([snapshot.turn?.id, snapshot.runs.map((run) => [run.id, run.sessionID, run.promptMessageID])])
}

function control(snapshot: ArenaSchema.Snapshot): ArenaSchema.Snapshot {
  return { ...snapshot, events: [], runs: snapshot.runs.map(({ messages, parts, ...run }) => run) }
}

export function createArenaStream(source: Source): Stream.Stream<Frame, Error> {
  return Stream.callback<Frame, Error>(
    (queue) =>
      Effect.gen(function* () {
        const bootstrap = new Map<string, LiveChange>()
        let pending: LiveChange[] = []
        let pendingBytes = 0
        let building = true
        let dirty = true
        let revision = 0
        let currentTurn: string | undefined
        let currentLifecycle = ""
        let currentSessions = new Map<string, string | undefined>()
        let lastControl = ""
        let overflow = false

        function fail() {
          overflow = true
          pending = []
          bootstrap.clear()
          Queue.failCauseUnsafe(queue, Cause.fail(new Error("Arena stream buffer exceeded; resynchronize")))
        }
        function changed() {
          dirty = true
          revision += 1
        }
        function capture(event: LiveNotification) {
          if (overflow) return
          if (!building && event.turnID !== currentTurn) return
          if (building) {
            // In-progress text already lives in the separate baseline overlay.
            if (event.change.kind === "text") return
            if (event.replacement.kind === "remove_message") {
              for (const [id, change] of bootstrap) {
                if (
                  change.runId === event.replacement.runId &&
                  change.kind === "part" &&
                  change.part.messageID === event.replacement.messageId
                ) {
                  pendingBytes -= Buffer.byteLength(JSON.stringify(change))
                  bootstrap.delete(id)
                }
              }
            }
            const id = key(event.replacement)
            const previous = bootstrap.get(id)
            if (previous) pendingBytes -= Buffer.byteLength(JSON.stringify(previous))
            bootstrap.set(id, event.replacement)
            pendingBytes += Buffer.byteLength(JSON.stringify(event.replacement))
          } else {
            const change = event.change
            const previous = pending.at(-1)
            if (
              previous?.kind === "text" &&
              change.kind === "text" &&
              key(previous) === key(change) &&
              previous.offset + previous.text.length === change.offset
            ) {
              previous.text += change.text
            } else pending.push({ ...change })
            pendingBytes += Buffer.byteLength(JSON.stringify(change))
          }
          if (pendingBytes > 4 * 1024 * 1024 || bootstrap.size + pending.length > 256) fail()
        }

        const off = source.live.subscribe(capture)
        const offDirty = source.live.onDirty(changed)
        const offChange = source.onChange(changed)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            off()
            offDirty()
            offChange()
            pending = []
            bootstrap.clear()
          }),
        )

        const hydrate = Effect.gen(function* () {
          building = true
          pending = []
          pendingBytes = 0
          bootstrap.clear()
          const read = yield* source.read(true)
          if (overflow) return yield* Effect.fail(new Error("Arena bootstrap buffer exceeded"))
          const snapshot = reconcileBootstrap(read, bootstrap.values(), source.live)
          currentTurn = snapshot.turn?.id
          currentLifecycle = lifecycle(snapshot)
          currentSessions = new Map(snapshot.runs.map((run) => [run.id, run.sessionID]))
          lastControl = JSON.stringify(control(snapshot))
          bootstrap.clear()
          pendingBytes = 0
          building = false
          yield* Queue.offer(queue, { kind: "snapshot", snapshot })
        })
        yield* hydrate

        const flush = Effect.gen(function* () {
          if (building || overflow || !pending.length) return
          // A newly prepared session can emit before its control read finishes.
          // Hold that run's events until hydration publishes its session identity.
          const blocked = new Set(
            pending
              .filter((change) => {
                if (!currentSessions.get(change.runId)) return true
                if (change.kind === "message") return currentSessions.get(change.runId) !== change.message.sessionID
                if (change.kind === "part") return currentSessions.get(change.runId) !== change.part.sessionID
                return false
              })
              .map((change) => change.runId),
          )
          if (blocked.size) dirty = true
          const changes = pending.filter((change) => !blocked.has(change.runId))
          pending = pending.filter((change) => blocked.has(change.runId))
          pendingBytes = pending.reduce((bytes, change) => bytes + Buffer.byteLength(JSON.stringify(change)), 0)
          if (!changes.length) return
          yield* Queue.offer(queue, { kind: "changes", changes })
        })
        const tick = Effect.gen(function* () {
          if (overflow) return
          if (dirty) {
            dirty = false
            const started = revision
            const snapshot = yield* source.read(false)
            if (started !== revision) {
              dirty = true
              return
            }
            if (lifecycle(snapshot) !== currentLifecycle) {
              yield* hydrate
              return
            }
            const serialized = JSON.stringify(snapshot)
            if (serialized !== lastControl) {
              yield* flush
              lastControl = serialized
              yield* Queue.offer(queue, { kind: "changes", changes: [{ kind: "state", snapshot }] })
            }
          }
        })
        yield* flush.pipe(
          Effect.andThen(Effect.sleep("100 millis")),
          Effect.forever,
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              Queue.failCauseUnsafe(queue, cause)
            }),
          ),
          Effect.forkScoped,
        )
        yield* tick.pipe(
          Effect.andThen(Effect.sleep("100 millis")),
          Effect.forever,
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              Queue.failCauseUnsafe(queue, cause)
            }),
          ),
          Effect.forkScoped,
        )
        // Service liveness has no event source; changed discoveries notify through the Store.
        yield* source.discover.pipe(
          Effect.andThen(Effect.sleep("1 second")),
          Effect.forever,
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              Queue.failCauseUnsafe(queue, cause)
            }),
          ),
          Effect.forkScoped,
        )
      }),
    { bufferSize: 1 },
  )
}
