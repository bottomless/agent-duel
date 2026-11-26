import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { createPromptDeclines } from "@/arena/prompt-declines"

const run = { _id: "side-a", rootSessionID: "parent" }

test("dismissing a background child's card does not explain a later parent interrupt", async () => {
  const declines = createPromptDeclines()
  await Effect.runPromise(declines.reply(run, Effect.succeed("child")))
  expect(await Effect.runPromise(declines.take(run._id))).toBe(false)
})

test("a failed reply neither marks the run nor undoes a successful decline", async () => {
  const declines = createPromptDeclines()
  const failure = Effect.fail(new Error("request already settled"))
  expect(Exit.isFailure(await Effect.runPromiseExit(declines.reply(run, failure)))).toBe(true)
  expect(await Effect.runPromise(declines.take(run._id))).toBe(false)

  await Effect.runPromise(declines.reply(run, Effect.succeed(run.rootSessionID)))
  expect(Exit.isFailure(await Effect.runPromiseExit(declines.reply(run, failure)))).toBe(true)
  expect(await Effect.runPromise(declines.take(run._id))).toBe(true)
  expect(await Effect.runPromise(declines.take(run._id))).toBe(false)
})

test("settlement sees a root decline even when the prompt ends before the reply returns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const declines = createPromptDeclines()
      const promptEnded = yield* Deferred.make<void>()
      const acknowledged = yield* Deferred.make<string>()
      const reply = yield* declines
        .reply(run, Deferred.succeed(promptEnded, undefined).pipe(Effect.andThen(Deferred.await(acknowledged))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(promptEnded)
      const settlement = yield* declines.take(run._id).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(acknowledged, run.rootSessionID)
      yield* Fiber.join(reply)
      expect(yield* Fiber.join(settlement)).toBe(true)
    }),
  ))
