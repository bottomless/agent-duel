import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Watcher } from "@opencode/core/filesystem/watcher"

test("Windows leaves recursive watchers off unless explicitly enabled", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "win32" })
  let acquired = 0
  const native = Layer.succeed(Watcher.Native, {
    subscribe: () => Effect.sync(() => {
      acquired++
      return { unsubscribe: async () => {} }
    }),
  })
  try {
    await Effect.gen(function* () {
      const watcher = yield* Watcher.Service
      const stream = yield* watcher.subscribe({ path: "/project", type: "directory" })
      yield* Stream.runDrain(stream)
    }).pipe(Effect.provide(Watcher.layer().pipe(Layer.provide(native))), Effect.scoped, Effect.runPromise)
    expect(acquired).toBe(0)
    await Effect.gen(function* () {
      const watcher = yield* Watcher.Service
      const stream = yield* watcher.subscribe({ path: "/project", type: "directory" }, Effect.interrupt)
      yield* Stream.runDrain(stream)
    }).pipe(Effect.provide(Watcher.layer({ enabled: true }).pipe(Layer.provide(native))), Effect.scoped, Effect.exit, Effect.runPromise)
    expect(acquired).toBe(1)
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
})
