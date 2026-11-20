import { Effect } from "effect"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { Shell } from "@opencode/core/shell"
import { Job } from "@opencode/core/job"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import type { Job as JobInfo } from "@opencode/schema/job"

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

/** A background command of a contestant session whose result has not reached the session yet. */
export interface PendingShell {
  readonly shellID: string
  /** False once the command exited and Core is delivering its result. */
  readonly running: boolean
  /** When the command started, in epoch milliseconds. */
  readonly started: number
  /** The shell's process, which leads the process group a server listens from. */
  readonly pid?: number
}

/**
 * A session's background shell commands from Core's background job list, which holds a job from its
 * handoff until its result is delivered, and the Location's shells, which hold each command's process.
 */
export function pendingShellsOf(
  jobs: readonly JobInfo.Info[],
  shells: readonly { readonly id: string; readonly pid?: number }[],
  sessionID: string,
): PendingShell[] {
  const pids = new Map(shells.map((info) => [String(info.id), info.pid]))
  return jobs.flatMap((item): PendingShell[] => {
    if (item.kind !== "shell" || item.sessionID !== sessionID) return []
    const pid = pids.get(item.shellID)
    return [
      {
        shellID: item.shellID,
        running: item.status === "running",
        started: item.time.started,
        ...(pid === undefined ? {} : { pid }),
      },
    ]
  })
}

/** How often a running command is checked again for a listening port. */
export const SERVER_CHECK_INTERVAL_MS = 1_000

/**
 * The background commands a side still waits for, as it waits for background child agents, so a build or
 * test that outlives its call reaches the contestant before the vote. A side ends when its contestant stops,
 * and a result that arrives after that is dropped (`shellNotification`). A command listening on a port is
 * a server kept for Preview, so it does not hold the side. Neither does one still running after the
 * foreground limit: a command that never ends would otherwise hold the side forever.
 */
export function awaitedShells(
  shells: readonly PendingShell[],
  now: number,
  isServer: (pid: number) => Effect.Effect<boolean>,
) {
  return Effect.gen(function* () {
    let count = 0
    for (const shell of shells) {
      // Core keeps a finished command listed until its result is delivered, so that result is on its way.
      if (!shell.running) {
        count++
        continue
      }
      if (now - shell.started >= MAX_FOREGROUND_TIMEOUT_MS) continue
      if (shell.pid !== undefined && (yield* isServer(shell.pid))) continue
      count++
    }
    return count
  })
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
