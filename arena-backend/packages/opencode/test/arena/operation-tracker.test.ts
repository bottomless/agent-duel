import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { createArenaOperationTracker, mergeOperationProgress } from "../../src/arena/operation-tracker"

describe("arena operation progress", () => {
  test("keeps the first part of an operation that completes and starts again", () => {
    const saved = { operation: "preserving_results", state: "completed", startedAt: 0, finishedAt: 100 } as const
    const firstPart = mergeOperationProgress([saved], {
      operation: "applying_changes",
      state: "completed",
      startedAt: 1_000,
      finishedAt: 31_000,
    })
    const resumed = mergeOperationProgress(firstPart, {
      operation: "applying_changes",
      state: "running",
      startedAt: 33_000,
    })
    expect(resumed).toEqual([saved, { operation: "applying_changes", state: "running", startedAt: 3_000 }])
    const finished = mergeOperationProgress(resumed, {
      operation: "applying_changes",
      state: "completed",
      startedAt: 33_000,
      finishedAt: 33_050,
    })
    expect(finished).toEqual([
      saved,
      { operation: "applying_changes", state: "completed", startedAt: 3_000, finishedAt: 33_050 },
    ])
  })

  test("starts a step that runs again in a new attempt fresh", () => {
    const checked = {
      operation: "checking_workspace",
      state: "completed",
      startedAt: 1_000,
      finishedAt: 3_000,
    } as const
    const replanned = mergeOperationProgress([checked], {
      operation: "checking_workspace",
      state: "running",
      startedAt: 90_000,
    })
    expect(replanned).toEqual([{ operation: "checking_workspace", state: "running", startedAt: 90_000 }])
    expect(
      mergeOperationProgress(replanned, {
        operation: "checking_workspace",
        state: "completed",
        startedAt: 90_000,
        finishedAt: 91_000,
      }),
    ).toEqual([{ operation: "checking_workspace", state: "completed", startedAt: 90_000, finishedAt: 91_000 }])
  })

  test("starts a retry after a failure fresh", () => {
    const failed = { operation: "applying_changes", state: "failed", startedAt: 1_000, finishedAt: 31_000 } as const
    const retry = mergeOperationProgress([failed], {
      operation: "applying_changes",
      state: "running",
      startedAt: 60_000,
    })
    expect(retry).toEqual([{ operation: "applying_changes", state: "running", startedAt: 60_000 }])
    expect(
      mergeOperationProgress(retry, {
        operation: "applying_changes",
        state: "completed",
        startedAt: 60_000,
        finishedAt: 61_000,
      }),
    ).toEqual([{ operation: "applying_changes", state: "completed", startedAt: 60_000, finishedAt: 61_000 }])
  })
})

describe("arena operation tracker", () => {
  test("keeps a shared operation visible until its last lease ends", async () => {
    const published: (readonly string[])[] = []
    const tracker = createArenaOperationTracker({
      publish: (_turnID, operations) =>
        Effect.sync(() => {
          published.push([...operations])
        }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const firstDone = yield* Deferred.make<void>()
        const secondDone = yield* Deferred.make<void>()
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const first = yield* tracker
          .track(
            "turn",
            "copying_environment",
            Effect.gen(function* () {
              yield* Deferred.succeed(firstEntered, undefined)
              yield* Deferred.await(firstDone)
            }),
          )
          .pipe(Effect.forkChild)
        const second = yield* tracker
          .track(
            "turn",
            "copying_environment",
            Effect.gen(function* () {
              yield* Deferred.succeed(secondEntered, undefined)
              yield* Deferred.await(secondDone)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        yield* Deferred.await(secondEntered)
        yield* Deferred.succeed(firstDone, undefined)
        yield* Fiber.join(first)
        expect(tracker.snapshot("turn")).toEqual(["copying_environment"])
        yield* Deferred.succeed(secondDone, undefined)
        yield* Fiber.join(second)
      }),
    )

    expect(tracker.snapshot("turn")).toEqual([])
    expect(published.at(-1)).toEqual([])
  })

  test("publishes concurrent different operations as a set", async () => {
    const published: (readonly string[])[] = []
    const tracker = createArenaOperationTracker({
      publish: (_turnID, operations) =>
        Effect.sync(() => {
          published.push([...operations])
        }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const firstDone = yield* Deferred.make<void>()
        const secondDone = yield* Deferred.make<void>()
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const first = yield* tracker
          .track(
            "turn",
            "preparing_workspaces",
            Effect.gen(function* () {
              yield* Deferred.succeed(firstEntered, undefined)
              yield* Deferred.await(firstDone)
            }),
          )
          .pipe(Effect.forkChild)
        const second = yield* tracker
          .track(
            "turn",
            "copying_environment",
            Effect.gen(function* () {
              yield* Deferred.succeed(secondEntered, undefined)
              yield* Deferred.await(secondDone)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        yield* Deferred.await(secondEntered)
        expect(tracker.snapshot("turn")).toEqual(["preparing_workspaces", "copying_environment"])
        yield* Deferred.succeed(firstDone, undefined)
        yield* Deferred.succeed(secondDone, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )

    expect(published.at(-1)).toEqual([])
    expect(published.some((item) => item.length === 2)).toBe(true)
  })

  test("clears on failure and interruption", async () => {
    const tracker = createArenaOperationTracker({ publish: () => Effect.void })
    await Effect.runPromise(
      tracker.track("turn", "applying_changes", Effect.fail(new Error("failed"))).pipe(Effect.ignore),
    )
    expect(tracker.snapshot("turn")).toEqual([])

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const fiber = yield* tracker
          .track(
            "turn",
            "applying_changes",
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(tracker.snapshot("turn")).toEqual([])
      }),
    )
  })

  test("records completed, failed, and interrupted exits, including overlap", async () => {
    const progress: Array<{ operation: string; state: string; startedAt: number; finishedAt?: number }> = []
    const tracker = createArenaOperationTracker({
      publish: (_turnID, _operations, entry) =>
        Effect.sync(() => {
          if (entry) progress.push(entry)
        }),
    })

    await Effect.runPromise(tracker.track("success", "applying_changes", Effect.void))
    expect(progress.at(-1)).toMatchObject({ operation: "applying_changes", state: "completed" })

    await Effect.runPromise(
      tracker.track("failure", "applying_changes", Effect.fail(new Error("failed"))).pipe(Effect.ignore),
    )
    expect(progress.at(-1)).toMatchObject({ operation: "applying_changes", state: "failed" })

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const fiber = yield* tracker
          .track(
            "interrupted",
            "applying_changes",
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(progress.at(-1)).toMatchObject({ operation: "applying_changes", state: "interrupted" })

    const firstDone = yieldDeferred()
    const firstStarted = yieldDeferred()
    const thirdStarted = yieldDeferred()
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* tracker
          .track(
            "overlap",
            "copying_environment",
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(firstDone)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.exit(tracker.track("overlap", "copying_environment", Effect.fail(new Error("one lease failed"))))
        expect(progress.at(-1)?.state).not.toBe("failed")
        const third = yield* tracker
          .track(
            "overlap",
            "copying_environment",
            Effect.gen(function* () {
              yield* Deferred.succeed(thirdStarted, undefined)
              yield* Effect.never
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.interrupt(third)
        yield* Deferred.succeed(firstDone, undefined)
        yield* Fiber.join(first)
      }),
    )
    expect(progress.at(-1)).toMatchObject({ operation: "copying_environment", state: "failed" })
  })

  test("serializes delayed publications in mutation order", async () => {
    const published: (readonly string[])[] = []
    const firstPublicationStarted = yieldDeferred()
    const releaseFirstPublication = yieldDeferred()
    let publicationCount = 0
    const tracker = createArenaOperationTracker({
      publish: (_turnID, operations) =>
        Effect.gen(function* () {
          publicationCount += 1
          if (publicationCount === 1) {
            yield* Deferred.succeed(firstPublicationStarted, undefined)
            yield* Deferred.await(releaseFirstPublication)
          }
          published.push([...operations])
        }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* tracker.track("turn", "preparing_workspaces", Effect.void).pipe(Effect.forkChild)
        yield* Deferred.await(firstPublicationStarted)
        const second = yield* tracker.track("turn", "copying_environment", Effect.never).pipe(Effect.forkChild)
        for (let attempt = 0; attempt < 10 && tracker.snapshot("turn").length < 2; attempt++) {
          yield* Effect.yieldNow
        }
        expect(tracker.snapshot("turn")).toEqual(["preparing_workspaces", "copying_environment"])
        yield* Deferred.succeed(releaseFirstPublication, undefined)
        yield* Fiber.join(first)
        yield* Fiber.interrupt(second)
      }),
    )

    expect(published[0]).toEqual(["preparing_workspaces"])
    expect(published[1]).toEqual(["preparing_workspaces", "copying_environment"])
    expect(published.at(-1)).toEqual([])
  })
})

function yieldDeferred() {
  return Effect.runSync(Deferred.make<void>())
}
