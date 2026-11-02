import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Store } from "./mongo"
import type { ShellRecord } from "./engine-runtime/shell-ledger"

/** Save the affected session family before recovery can dispose its children. */
export const recordStoppedShells = Effect.fn("Arena.recordStoppedShells")(function* (
  store: Store,
  shells: readonly ShellRecord[],
  stoppedAt: number,
  parent: (sessionID: string) => Effect.Effect<string | undefined, Error>,
) {
  for (const shell of shells) {
    let sessionID = shell.sessionID
    while (sessionID) {
      const current = sessionID
      const run = yield* Effect.tryPromise(() =>
        store.runs.findOne({ $or: [{ rootSessionID: current }, { descendantSessionIDs: current }] }),
      )
      const turn = run ? yield* Effect.tryPromise(() => store.turn(run.turnID)) : undefined
      const chat = turn
        ? yield* Effect.tryPromise(() => store.chat(turn.chatID))
        : yield* Effect.tryPromise(() => store.chatForSession(current))
      if (chat) {
        yield* Effect.tryPromise(() =>
          store.updateChat(
            { _id: chat._id },
            {
              $addToSet: {
                shellStops: {
                  id: shell.id,
                  sessionID: run?.rootSessionID ?? current,
                  startedAt: shell.spawnedAfter,
                  stoppedAt,
                },
              },
            },
          ),
        )
        break
      }
      sessionID = yield* parent(sessionID)
    }
  }
})

export function shellRestartInput(sessionID: string, shellIDs: readonly string[] = []) {
  if (shellIDs.length === 0) return undefined
  const identity = createHash("sha256")
    .update(JSON.stringify([sessionID, [...shellIDs].sort()]))
    .digest("hex")
  return {
    id: `msg_arena_shell_restart_${identity}`,
    text: "The engine restarted, and your background shell stopped. Start it again if it is still needed.",
  }
}
