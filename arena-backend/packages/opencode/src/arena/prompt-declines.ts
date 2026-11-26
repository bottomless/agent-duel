import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Effect } from "effect"
import type { RunDocument } from "./records"

export function createPromptDeclines() {
  const gates = KeyedMutex.makeUnsafe<string>()
  const declined = new Set<string>()
  return {
    // Core can interrupt the prompt before the reply fiber returns. Let settlement wait for
    // acknowledgement rather than marking speculatively and rolling back on a failed reply.
    reply: (run: Pick<RunDocument, "_id" | "rootSessionID">, reject: Effect.Effect<string | undefined, Error>) =>
      gates.withLock(run._id)(
        Effect.uninterruptible(
          reject.pipe(
            Effect.map((owner) => {
              if (owner === run.rootSessionID) declined.add(run._id)
            }),
          ),
        ),
      ),
    take: (runID: string) => gates.withLock(runID)(Effect.sync(() => declined.delete(runID))),
  }
}
