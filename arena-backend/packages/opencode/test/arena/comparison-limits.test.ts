import { expect } from "bun:test"
import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { compare, OperationError } from "@/arena/git"
import { Git } from "@/git"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.empty)
const input = { canonical: "/comparison", baseCommit: "base", aCommit: "a", bCommit: "b" }

it.live("battle comparison handles a large rewrite with native Git", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const base = Array.from({ length: 25000 }, (_, i) => `before-${i}\n`).join("")
    const changed = Array.from({ length: 25000 }, (_, i) => `after-${i}\n`).join("")
    yield* Effect.promise(() => Bun.write(`${tmp.path}/rewrite.txt`, base))
    yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
    yield* Effect.promise(() => $`git commit -m base`.cwd(tmp.path).quiet())
    const baseCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tmp.path).quiet().text())).trim()
    yield* Effect.promise(() => Bun.write(`${tmp.path}/rewrite.txt`, changed))
    yield* Effect.promise(() => $`git commit -am rewritten`.cwd(tmp.path).quiet())
    const aCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tmp.path).quiet().text())).trim()
    const evidence = yield* compare({ canonical: tmp.path, baseCommit, aCommit, bCommit: baseCommit }).pipe(
      Effect.provide(LayerNode.compile(Git.node)),
    )
    expect(evidence.stats).toEqual([{ file: "rewrite.txt", additions: 25000, deletions: 25000, binary: false }])
    expect(evidence.divergence.files).toEqual([{ file: "rewrite.txt", status: "only_a" }])
    expect(evidence.files).toHaveLength(1)
    expect(evidence.baseToA).toContain("+after-24999")
  }),
)

// Controlled Git effects make deadlines and cancellation deterministic without slow shell commands.
it.effect("comparison timeout interrupts Git and releases the shared execution slot", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let interrupted = false
    const blocked = Layer.mock(Git.Service, {
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        ),
    })
    const fiber = yield* compare(input).pipe(Effect.provide(blocked), Effect.exit, Effect.forkScoped)
    yield* Deferred.await(started)
    yield* TestClock.adjust("15 seconds")
    const result = yield* Fiber.join(fiber)
    if (!Exit.isFailure(result)) throw new Error("Expected comparison timeout")
    const error = Cause.squash(result.cause)
    expect(error).toBeInstanceOf(OperationError)
    expect(String(error)).toContain("15 second time limit")
    expect(interrupted).toBe(true)

    let entered = false
    yield* compare(input).pipe(
      Effect.provide(
        Layer.mock(Git.Service, {
          run: () =>
            Effect.sync(() => {
              entered = true
              return {
                exitCode: 1,
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("test refusal"),
                text: () => "",
                truncated: false,
              }
            }),
        }),
      ),
      Effect.exit,
    )
    expect(entered).toBe(true)
  }),
)

it.effect("comparison refuses truncated metadata instead of reporting incomplete evidence", () =>
  Effect.gen(function* () {
    const result = yield* compare(input).pipe(
      Effect.provide(
        Layer.mock(Git.Service, {
          run: (args) =>
            Effect.succeed({
              exitCode: 0,
              stdout: Buffer.from("partial"),
              stderr: Buffer.alloc(0),
              text: () => "partial",
              truncated: args.includes("--numstat"),
            }),
        }),
      ),
      Effect.exit,
    )
    if (!Exit.isFailure(result)) throw new Error("Expected metadata limit failure")
    expect(Cause.squash(result.cause)).toBeInstanceOf(OperationError)
    expect(String(Cause.squash(result.cause))).toContain("16 MiB output limit")
  }),
)
