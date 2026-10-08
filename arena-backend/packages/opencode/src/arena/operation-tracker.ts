import { Cause, Deferred, Effect, Exit } from "effect"

/** Operations that can be shown while a battle is moving between public states. */
export const ArenaActiveOperation = [
  "preparing_workspaces",
  "copying_environment",
  "checking_workspace",
  "releasing_environment",
  "preserving_results",
  "applying_changes",
  "updating_conversation",
  "releasing_loser",
] as const

export type ArenaActiveOperation = (typeof ArenaActiveOperation)[number]

export type ArenaOperationProgress =
  | {
      readonly operation: ArenaActiveOperation
      readonly startedAt: number
      readonly state: "running"
    }
  | {
      readonly operation: ArenaActiveOperation
      readonly startedAt: number
      readonly finishedAt: number
      readonly state: "completed" | "failed" | "interrupted"
    }

/**
 * Folds one update into a turn's recorded progress. A vote applies changes in two parts with a
 * Store write between them, so `applying_changes` completes and starts again; replacing the
 * entry let the 0.05 s second part erase the 30 s first one, and the row finished as "<1s". Its
 * second part carries the first part's time forward by starting that much earlier, so the gap
 * between the parts is not counted. Any other restart is a new attempt, such as the plan running
 * again after the developer answers a review, and starts fresh.
 */
export function mergeOperationProgress(
  existing: readonly ArenaOperationProgress[],
  progress: ArenaOperationProgress,
): ArenaOperationProgress[] {
  const previous = existing.find((entry) => entry.operation === progress.operation)
  if (!previous) return [...existing, progress]
  let startedAt = progress.startedAt
  if (
    progress.operation === "applying_changes" &&
    previous.state === "completed" &&
    progress.startedAt >= previous.finishedAt
  ) {
    startedAt -= previous.finishedAt - previous.startedAt
  } else if (previous.state === "running" && progress.state !== "running") {
    // The run that is ending may have been moved earlier when it started.
    startedAt = Math.min(previous.startedAt, progress.startedAt)
  }
  return existing.map((entry) => (entry === previous ? { ...progress, startedAt } : entry))
}

type Publish = (
  turnID: string,
  activeOperations: readonly ArenaActiveOperation[],
  progress?: ArenaOperationProgress,
) => Effect.Effect<void, unknown, never>
type Log = (input: {
  readonly turnID: string
  readonly operation: ArenaActiveOperation
  readonly durationMs: number
}) => Effect.Effect<void, never, never>
type OperationState = { count: number; startedAt: number; failed?: "failed" | "interrupted" }

/**
 * Tracks overlapping async work without allowing one completion to hide another operation.
 * Acquire and release are managed by Effect so every interruption and failure runs the release
 * exactly once. Each turn serializes its Store updates so a fast completion cannot overtake a start.
 */
export function createArenaOperationTracker(input: { readonly publish: Publish; readonly log?: Log }) {
  const operations = new Map<string, Map<ArenaActiveOperation, OperationState>>()
  const publicationTails = new Map<string, Deferred.Deferred<void>>()

  const snapshot = (turnID: string): readonly ArenaActiveOperation[] => [...(operations.get(turnID)?.keys() ?? [])]

  const publish = (
    turnID: string,
    operation: ArenaActiveOperation,
    activeOperations: readonly ArenaActiveOperation[],
    progress?: ArenaOperationProgress,
  ) => {
    const previous = publicationTails.get(turnID)
    const current = Deferred.makeUnsafe<void>()
    publicationTails.set(turnID, current)
    return Effect.gen(function* () {
      if (previous) yield* Deferred.await(previous)
      yield* input
        .publish(turnID, [...activeOperations], progress)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Arena transition progress publication failed", { turnID, operation, cause }),
          ),
        )
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(current, undefined).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (current === publicationTails.get(turnID) && !operations.has(turnID)) publicationTails.delete(turnID)
            }),
          ),
        ),
      ),
    )
  }

  const acquire = (turnID: string, operation: ArenaActiveOperation) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const turn = operations.get(turnID) ?? new Map<ArenaActiveOperation, OperationState>()
        const current = turn.get(operation)
        const startedAt = current?.startedAt ?? Date.now()
        turn.set(operation, current ? { ...current, count: current.count + 1 } : { count: 1, startedAt })
        operations.set(turnID, turn)
        yield* publish(
          turnID,
          operation,
          snapshot(turnID),
          current ? undefined : { operation, startedAt, state: "running" },
        )
      }),
    )

  const release = (turnID: string, operation: ArenaActiveOperation, exit: Exit.Exit<unknown, unknown>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const turn = operations.get(turnID)
        const current = turn?.get(operation)
        if (!current) return yield* publish(turnID, operation, snapshot(turnID))
        let failed: "failed" | "interrupted" | undefined
        if (Exit.isFailure(exit)) failed = Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed"
        if (current.count <= 1) {
          turn?.delete(operation)
          if (turn && turn.size === 0) operations.delete(turnID)
          let state: "completed" | "failed" | "interrupted" = "completed"
          if (current.failed === "failed" || failed === "failed") state = "failed"
          else if (current.failed === "interrupted" || failed === "interrupted") state = "interrupted"
          const finishedAt = Date.now()
          yield* input.log?.({ turnID, operation, durationMs: finishedAt - current.startedAt }) ?? Effect.void
          yield* publish(turnID, operation, snapshot(turnID), {
            operation,
            startedAt: current.startedAt,
            finishedAt,
            state,
          })
          return
        } else {
          let aggregateFailure = current.failed
          if (failed === "failed" || current.failed === "failed") aggregateFailure = "failed"
          else if (failed === "interrupted" || current.failed === "interrupted") aggregateFailure = "interrupted"
          const next = { ...current, count: current.count - 1 }
          if (aggregateFailure) next.failed = aggregateFailure
          turn?.set(operation, next)
        }
        yield* publish(turnID, operation, snapshot(turnID))
      }),
    )

  const track = <A, E, R>(turnID: string, operation: ArenaActiveOperation, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(turnID, operation),
      () => effect,
      (_resource, exit) => release(turnID, operation, exit),
    )

  return { track, snapshot }
}
