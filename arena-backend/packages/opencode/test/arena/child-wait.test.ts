import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { CHILD_WAIT_TIMEOUT_MS, withChildWaitLimit } from "@/arena/child-wait"

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise)

const waitingSide = Effect.gen(function* () {
  const ended = yield* Deferred.make<Exit.Exit<string, Error>>()
  const events: string[] = []
  const logs: unknown[] = []
  const fiber = yield* withChildWaitLimit(
    Deferred.await(ended).pipe(Effect.ensuring(Effect.sync(() => events.push("wait ended")))),
    {
      runID: "side-a",
      limitMs: 50,
      cancel: Effect.sync(() => {
        events.push("cancel children")
      }),
    },
  ).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => logs.push(entry.message))])),
    Effect.forkChild,
  )
  yield* Effect.yieldNow
  return { ended, events, fiber, logs }
})

describe("Arena background child wait limit", () => {
  test("a hung child expires, cancels through the supplied Stop path, and returns a logged side failure", () =>
    run(
      Effect.gen(function* () {
        expect(CHILD_WAIT_TIMEOUT_MS).toBe(18_000_000)
        const side = yield* waitingSide
        yield* TestClock.adjust("49 millis")
        expect(side.events).toEqual([])
        yield* TestClock.adjust("1 millis")
        const result = yield* Fiber.join(side.fiber)
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) throw new Error("Expected a failed side")
        const reason = Cause.pretty(result.cause)
        expect(reason).toContain("Background child agents exceeded the 50ms wait time limit")
        expect(JSON.stringify(side.logs)).toContain("Background child agents exceeded the 50ms wait time limit")
        expect(JSON.stringify(side.logs)).toContain("side-a")
        expect(side.events).toEqual(["wait ended", "cancel children"])
        yield* TestClock.adjust("1 hour")
        expect(side.events).toHaveLength(2)
      }),
    ))

  test("Stop ends the wait immediately and its old timer cannot cancel the side later", () =>
    run(
      Effect.gen(function* () {
        const side = yield* waitingSide
        yield* TestClock.adjust("1 millis")
        yield* Deferred.succeed(side.ended, Exit.succeed("stopped"))
        // No clock advance: Stop must not wait for the remaining limit.
        expect(yield* Fiber.join(side.fiber)).toEqual(Exit.succeed("stopped"))
        yield* TestClock.adjust("1 hour")
        expect(side.events).toEqual(["wait ended"])
        expect(side.logs).toEqual([])
      }),
    ))

  test("a child that finishes normally clears the timer", () =>
    run(
      Effect.gen(function* () {
        const side = yield* waitingSide
        yield* TestClock.adjust("49 millis")
        yield* Deferred.succeed(side.ended, Exit.succeed("parent answered the child"))
        expect(yield* Fiber.join(side.fiber)).toEqual(Exit.succeed("parent answered the child"))
        yield* TestClock.adjust("1 hour")
        expect(side.events).toEqual(["wait ended"])
        expect(side.logs).toEqual([])
      }),
    ))

  test("a side that fails or is interrupted leaves no timeout action behind", () =>
    run(
      Effect.gen(function* () {
        const failed = yield* waitingSide
        const failure = Exit.fail(new Error("parent failed"))
        yield* Deferred.succeed(failed.ended, failure)
        expect(yield* Fiber.join(failed.fiber)).toEqual(failure)
        const interrupted = yield* waitingSide
        yield* Fiber.interrupt(interrupted.fiber)
        yield* TestClock.adjust("1 hour")
        for (const side of [failed, interrupted]) {
          expect(side.events).toEqual(["wait ended"])
          expect(side.logs).toEqual([])
        }
      }),
    ))
})
