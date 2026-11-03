import { expect, test } from "bun:test"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { encodeArenaStream } from "@/arena/sse"
import type { Frame } from "@/arena/stream"

function run<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise)
}

const capture = Effect.gen(function* () {
  const clock = yield* Clock.clockWith(Effect.succeed)
  const started = yield* Deferred.make<void>()
  let sleeping = 0
  const trackedClock: Clock.Clock = {
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (duration) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          sleeping++
          Deferred.doneUnsafe(started, Effect.void)
        }),
        () => clock.sleep(duration),
        () =>
          Effect.sync(() => {
            sleeping--
          }),
      ),
  }
  const input = yield* Queue.unbounded<Frame, Error | Cause.Done>()
  const output = yield* Queue.unbounded<string>()
  const fiber = yield* encodeArenaStream(Stream.fromQueue(input)).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Queue.offer(output, chunk)),
    Effect.provideService(Clock.Clock, trackedClock),
    Effect.forkChild,
  )
  yield* Deferred.await(started)
  return { input, output, fiber, sleeping: () => sleeping }
})

test("Arena SSE sends only small comments every ten seconds through an idle minute", () =>
  run(
    Effect.gen(function* () {
      const stream = yield* capture
      expect(stream.sleeping()).toBe(1)
      yield* TestClock.adjust("9 seconds")
      expect(yield* Queue.size(stream.output)).toBe(0)
      yield* TestClock.adjust("1 second")
      expect(yield* Queue.take(stream.output)).toBe(": heartbeat\n\n")
      for (let i = 0; i < 6; i++) {
        yield* TestClock.adjust("10 seconds")
        expect(yield* Queue.take(stream.output)).toBe(": heartbeat\n\n")
      }
      const frame: Frame = { kind: "changes", changes: [] }
      yield* Queue.offer(stream.input, frame)
      expect(yield* Queue.take(stream.output)).toBe(`data: ${JSON.stringify(frame)}\n\n`)
      yield* Fiber.interrupt(stream.fiber)
      expect(stream.sleeping()).toBe(0)
      yield* TestClock.adjust("1 hour")
      expect(yield* Queue.size(stream.output)).toBe(0)
    }),
  ))

for (const ending of ["complete", "fail"] as const) {
  test(`Arena SSE cancels its heartbeat when the source ${ending}s`, () =>
    run(
      Effect.gen(function* () {
        const stream = yield* capture
        expect(stream.sleeping()).toBe(1)
        if (ending === "complete") yield* Queue.end(stream.input)
        else yield* Queue.fail(stream.input, new Error("source failed"))
        const exit = yield* Fiber.await(stream.fiber)
        expect(Exit.isSuccess(exit)).toBe(ending === "complete")
        expect(stream.sleeping()).toBe(0)
        yield* TestClock.adjust("1 hour")
        expect(yield* Queue.size(stream.output)).toBe(0)
      }),
    ))
}
