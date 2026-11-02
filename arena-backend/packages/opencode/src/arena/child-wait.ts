import { Duration, Effect, Exit } from "effect"

/** A last resort for a hung background child, not an ordinary execution deadline. */
export const CHILD_WAIT_TIMEOUT_MS = 5 * 60 * 60_000

export function withChildWaitLimit<A, E, R, E2, R2>(
  wait: Effect.Effect<Exit.Exit<A, Error>, E, R>,
  options: {
    readonly runID: string
    readonly cancel: Effect.Effect<void, E2, R2>
    readonly limitMs?: number
  },
) {
  const limitMs = options.limitMs ?? CHILD_WAIT_TIMEOUT_MS
  return wait.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(limitMs),
      orElse: () => {
        const reason = new Error(
          `Background child agents exceeded the ${Duration.format(Duration.millis(limitMs))} wait time limit`,
        )
        return Effect.gen(function* () {
          yield* Effect.logWarning(reason.message, { runID: options.runID, limitMs })
          yield* options.cancel.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Arena could not cancel timed-out child agents", { runID: options.runID, cause }),
            ),
          )
          // Return a failed prompt exit so normal side finalization stores the reason.
          return Exit.fail(reason)
        })
      },
    }),
  )
}
