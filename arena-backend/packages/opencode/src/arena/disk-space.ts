import { statfs } from "fs/promises"

/**
 * Disk space around a battle.
 *
 * A battle that runs out of disk used to lose the side whose result it was saving: the write
 * failed, the side ended in error, and nothing could retry it. The engine now waits for space and
 * saves the side once there is room, and it says before a battle starts when the disk is short.
 *
 * Production saw full disks only on Linux, where a checkout cannot be cloned copy-on-write and
 * every contestant worktree is a real copy. On APFS, btrfs and XFS the ignored content and the
 * host repository are clones; the tracked files are written fresh either way.
 */

/**
 * What stays free after a battle's estimated writes: the daemon's low-disk line (`LOW_DISK_BYTES`).
 * It covers what the contestants write themselves, which nothing can estimate. Tests raise it.
 */
export const diskHeadroomBytes = () => Number(process.env.OPENCODE_ARENA_DISK_HEADROOM_BYTES) || 10_000_000_000

/** How often a save waiting for disk space tries again. Tests shorten it. */
export const diskRetryMs = () => Number(process.env.OPENCODE_ARENA_DISK_RETRY_MS) || 15_000

/** A failure that more disk space would fix, from any layer: Node, git, SQLite, Windows. */
export function isDiskFull(cause: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (value === undefined || value === null || depth > 6 || seen.has(value)) return false
    seen.add(value)
    if (typeof value === "string") return DISK_FULL.test(value)
    if (typeof value !== "object") return false
    const record = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; stderr?: unknown }
    if (record.code === "ENOSPC" || record.code === "SQLITE_FULL") return true
    if (typeof record.message === "string" && DISK_FULL.test(record.message)) return true
    if (typeof record.stderr === "string" && DISK_FULL.test(record.stderr)) return true
    if (Array.isArray(record.errors) && record.errors.some((error) => visit(error, depth + 1))) return true
    return visit(record.cause, depth + 1)
  }
  return visit(cause, 0)
}

const DISK_FULL =
  /ENOSPC|no space left on device|SQLITE_FULL|database or disk is full|not enough space on the disk|disk quota exceeded|EDQUOT/i

/** The bytes a git object listing (`ls-tree -r -l -z`) says the tracked files hold. */
export function trackedBytesFromListing(listing: string) {
  let total = 0
  for (const entry of listing.split("\0")) {
    // `<mode> <type> <object> <size>\t<path>`; a submodule's size is `-`.
    const size = Number(entry.split("\t", 1)[0]?.trim().split(/\s+/)[3])
    if (Number.isFinite(size)) total += size
  }
  return total
}

/** The bytes `git count-objects -v` reports the object store holds, loose and packed. */
export function objectBytesFromCount(text: string) {
  const field = (name: string) => Number(text.match(new RegExp(`^${name}: (\\d+)`, "m"))?.[1] ?? 0)
  return (field("size") + field("size-pack") + field("size-garbage")) * 1024
}

/**
 * What a battle's new contestant worktrees will write before either model runs. A tracked file is
 * written fresh in every worktree. Where the checkout clones, its ignored content and the host
 * repository cost nothing until written; where it copies, both are real bytes per worktree. What
 * the contestants then write themselves, a build or an install, nothing can know in advance, which
 * is what `diskHeadroomBytes` is for.
 */
export function battleWriteEstimate(input: {
  /** Worktrees this send creates or rewrites in full; 0 when a prepared pair is reused. */
  readonly worktrees: number
  readonly cloned: boolean
  readonly trackedBytes: number
  readonly objectBytes: number
  readonly copiedIgnoredBytes: number
}) {
  const perWorktree = input.trackedBytes + (input.cloned ? 0 : input.objectBytes + input.copiedIgnoredBytes)
  return input.worktrees * perWorktree
}

/** Free bytes on the volume a path is on, or undefined when the platform cannot say. */
export async function freeBytes(path: string) {
  return statfs(path).then(
    (stats) => Number(stats.bavail) * Number(stats.bsize),
    () => undefined,
  )
}

export * as ArenaDiskSpace from "./disk-space"
