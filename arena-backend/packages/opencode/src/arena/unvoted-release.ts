import { readdir, rm } from "fs/promises"
import { join } from "path"
import { discardTree } from "@/util/discard-tree"
import type { BattleState } from "./domain"

/**
 * The files of a battle nobody votes on.
 *
 * A battle waiting for its vote, or for a decision after Stop, keeps both contestants' worktrees,
 * and environment release takes only ready chats, so an abandoned battle held them for good. Once
 * it has waited `unvotedReleaseMs` with its chat closed, the engine stops its servers and deletes
 * the worktrees' files. What a vote, a reply or a retry needs stays:
 *
 * - each side's result, recorded at finalize under `refs/battles/` in the checkout, which the vote
 *   applies and the Changes view reads;
 * - the contestant sessions, which the vote grafts into the chat;
 * - each worktree's `.git` link and its host beside it. A host rebuilt from the checkout would hold
 *   the other side's result, imported there at finalize, and a reply would let a contestant read it.
 *
 * A reply, a retry or a resume rebuilds a side's files from its recorded result and the checkout's
 * ignored content first (`restoreReleasedRun`). Ignored files a contestant wrote, such as installed
 * packages or a build, are gone; they were never part of its result.
 */

/** How long a battle waits for its vote with its chat closed before its files go. Tests shorten it. */
export const unvotedReleaseMs = () => Number(process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS) || 72 * 60 * 60_000

const WAITING: ReadonlySet<BattleState> = new Set(["awaiting_vote", "awaiting_stop_resolution"])

/**
 * Since when a battle has waited for its user, or undefined unless it is waiting: its state's own
 * timestamp, which a reply moves on, or the moment its chat was last closed, whichever is later.
 */
export function waitingSince(
  turn: {
    readonly state: BattleState
    readonly resolution?: unknown
    readonly transitionTimestamps?: Partial<Record<BattleState, Date>>
  },
  unwatchedAt?: number,
): number | undefined {
  if (!WAITING.has(turn.state) || turn.resolution !== undefined) return undefined
  const entered = turn.transitionTimestamps?.[turn.state]?.getTime()
  if (entered === undefined) return undefined
  return Math.max(entered, unwatchedAt ?? 0)
}

/**
 * Whether every side's result is recorded whole, so deleting its files loses nothing a vote, a
 * reply or a retry reads. A side stopped before it finalized, or one whose result could not be
 * saved, keeps its files.
 */
export function resultsRecorded(
  runs: readonly {
    readonly finalizedAt?: Date
    readonly worktreeRemovedAt?: Date
    readonly rawHead?: string
    readonly finalCommit?: string
    readonly finalTree?: string
    readonly finalIndexTree?: string
    readonly permanentRef?: string
  }[],
) {
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        run.finalizedAt !== undefined &&
        run.worktreeRemovedAt === undefined &&
        !!run.rawHead &&
        !!run.finalCommit &&
        !!run.finalTree &&
        !!run.finalIndexTree &&
        !!run.permanentRef,
    )
  )
}

/**
 * Delete everything in a contestant worktree but its `.git` link, through `trash`. The link keeps
 * the directory one of Arena's worktrees (`isPoolWorktree`), so the pool still reads it as this
 * run's and, after the vote, as a free slot to adopt. A tree Windows refuses to move while a handle
 * is open in it is deleted in place.
 */
export async function emptyWorktree(directory: string, trash: string) {
  let removed = 0
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (name === ".git") continue
    const target = join(directory, name)
    const grave = await discardTree(target, trash)
    await rm(grave ?? target, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export * as ArenaUnvotedRelease from "./unvoted-release"
