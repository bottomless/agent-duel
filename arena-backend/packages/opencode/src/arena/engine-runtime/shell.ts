import { Effect } from "effect"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Shell } from "@opencode/core/shell"
import { Job } from "@opencode/core/job"
import { ShellTool } from "@opencode/core/tool/plugin/shell"

export const MAX_FOREGROUND_TIMEOUT_MS = 10 * 60 * 1_000

const gates = KeyedMutex.makeUnsafe<string>()
const turns = new Map<string, object>()

export function openShellTurn(sessionID: string) {
  return gates.withLock(sessionID)(Effect.sync(() => void turns.set(sessionID, {})))
}

/** Close atomically with notification admission, including the runner/inbox check. */
export function closeShellTurn<E, R>(sessionID: string, more: Effect.Effect<boolean, E, R>) {
  return gates.withLock(sessionID)(
    more.pipe(
      Effect.tap((pending) =>
        Effect.sync(() => {
          if (!pending) turns.delete(sessionID)
        }),
      ),
    ),
  )
}

export function shellNotification(sessionID: string): ShellTool.NotificationPolicy {
  const turn = turns.get(sessionID)
  return (deliver) =>
    gates.withLock(sessionID)(
      Effect.suspend(() => (turn !== undefined && turns.get(sessionID) === turn ? deliver : Effect.void)),
    )
}

export function contestantShellInput(input: Record<string, unknown>) {
  if (input.background === true) return input
  const requested = input.timeout
  const timeout =
    typeof requested === "number" && requested > 0
      ? Math.min(requested, MAX_FOREGROUND_TIMEOUT_MS)
      : ShellTool.DEFAULT_TIMEOUT_MS
  return { ...input, timeout }
}

export function contestantShellTimeoutMessage(timeout: number) {
  return `Command exceeded the foreground timeout limit of ${timeout} ms. Use background: true for a server or a long-running command.`
}

/** Shell jobs are keyed by shell ID, unlike subagent jobs keyed by session ID. */
export function cancelSessionShells(sessionID: string) {
  return Effect.gen(function* () {
    const shell = yield* Shell.Service
    const jobs = yield* Job.Service
    const running = yield* shell.list()
    for (const info of running) {
      if (info.metadata.sessionID !== sessionID) continue
      yield* jobs.cancel(info.id)
      yield* shell.remove(info.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
    }
  })
}
