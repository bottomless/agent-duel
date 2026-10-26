import { Deferred, Effect } from "effect"

export interface ToolExecutionGate {
  readonly wait: (sessionID: string) => Effect.Effect<void>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

/** A staging gate used while a contestant worktree is being prepared. */
export function makeToolExecutionGate(): Effect.Effect<ToolExecutionGate> {
  return Effect.gen(function* () {
    const pending = new Map<string, Deferred.Deferred<void>>()
    let closed = false
    const wait = Effect.fn("ArenaToolExecutionGate.wait")((sessionID: string) =>
      Effect.gen(function* () {
        if (closed) return
        const current = pending.get(sessionID)
        if (current) return yield* Deferred.await(current)
        const deferred = yield* Deferred.make<void>()
        pending.set(sessionID, deferred)
        yield* Deferred.await(deferred)
      }),
    )
    const release = Effect.fn("ArenaToolExecutionGate.release")((sessionID: string) =>
      Effect.gen(function* () {
        const current = pending.get(sessionID)
        if (!current) return
        pending.delete(sessionID)
        yield* Deferred.succeed(current, undefined)
      }),
    )
    const close = Effect.gen(function* () {
      closed = true
      for (const deferred of pending.values()) yield* Deferred.succeed(deferred, undefined)
      pending.clear()
    })
    return { wait, release, close }
  })
}

export * as ArenaEngineGate from "./gate.js"
