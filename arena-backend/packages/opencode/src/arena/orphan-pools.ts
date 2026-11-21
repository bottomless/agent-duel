import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "path"
import { isolatedRoot } from "@/worktree"
import { discardTree, TRASH_DIRNAME } from "@/util/discard-tree"
import { STAGING_DIRNAME } from "./copy-snapshot"
import { chatSlug } from "./domain"

/**
 * Chat worktree pools no Arena home will ever clean up.
 *
 * Only the store whose chat owns a pool releases or archives it, and it looks for the pool where
 * the chat's checkout was when the chat was made. A pool is left for good when that store is gone
 * (its home was deleted or reset), when the checkout was moved or renamed and stays there (the
 * pools travel with it while the chat keeps looking at the old path), and when the checkout was
 * copied with them. Another home can still own a pool this store does not know: a source build's
 * dev home works in the same projects as the installed app. So each home writes a marker per pool
 * it owns, and a pool marked by a home that still exists is never touched.
 */

/** Beside the pools under `.agent-duel/worktrees`: one file per pool, named like it, naming its home. */
export const POOL_OWNERS_DIRNAME = ".owners"

/** A chat's pool directory is the first 16 hex characters of its id's SHA-256 (`chatSlug`). */
const POOL_NAME = /^[0-9a-f]{16}$/

/**
 * How long a pool its marker gives away sits untouched before it goes. A moved checkout's chat
 * asks the user to move it back; a day lets that happen before its worktrees are gone.
 */
export const MARKED_GRACE_MS = 24 * 60 * 60_000
/**
 * How long an unmarked pool sits untouched before it goes. Pools made before markers existed, and
 * pools of a home on a build that writes none, have no marker; a home that is still used renames
 * its pools' slots every turn, which this measures.
 */
export const UNMARKED_GRACE_MS = 14 * 24 * 60 * 60_000
/** A clone staged for a rename that never came: the engine that built it stopped. */
export const STAGING_GRACE_MS = 24 * 60 * 60_000

export type PoolOwner = { readonly home: string; readonly chatID: string }

export type OrphanReason =
  /** Marked by this home, but none of its chats has its pool here: the checkout moved or was copied. */
  | "unowned"
  /** Marked by a home whose store no longer exists. */
  | "home_gone"
  /** No marker, untouched for `UNMARKED_GRACE_MS`. */
  | "unmarked"

export type OrphanOutcome =
  | {
      readonly directory: string
      readonly reason: OrphanReason
      readonly owner?: PoolOwner
      readonly result: "removed"
    }
  | { readonly directory: string; readonly reason: OrphanReason; readonly owner?: PoolOwner; readonly result: "busy" }
  /** Windows refuses to move a tree while a handle is open in it; the next sweep tries again. */
  | { readonly directory: string; readonly reason: OrphanReason; readonly owner?: PoolOwner; readonly result: "stuck" }

export type OrphanSweep = {
  readonly pools: readonly OrphanOutcome[]
  /** Staged clones removed. */
  readonly staged: readonly string[]
  /** Set when the processes could not be listed, so nothing was removed. */
  readonly unlisted?: true
}

/** The pool directory a chat's worktrees live in; the same path `slotPool` in the service names. */
export function poolDirectory(checkout: string, chatID: string) {
  return join(isolatedRoot(checkout), chatSlug(chatID))
}

function samePath(left: string, right: string) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function identity(directory: string) {
  return realpath(directory).catch(() => resolve(directory))
}

/** Whether `directory` is `root` or lies inside it, compared as the platform compares paths. */
function within(root: string, directory: string) {
  const value = relative(root, directory)
  return !/^\.\.(?:[\\/]|$)/.test(value) && !isAbsolute(value)
}

function markerPath(isolated: string, name: string) {
  return join(isolated, POOL_OWNERS_DIRNAME, name)
}

async function readOwner(isolated: string, name: string): Promise<PoolOwner | undefined> {
  const text = await readFile(markerPath(isolated, name), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<PoolOwner>
    return typeof value.home === "string" && typeof value.chatID === "string"
      ? { home: value.home, chatID: value.chatID }
      : undefined
  } catch {
    return undefined
  }
}

/** Mark a chat's pool as this home's. Rewritten only when it says something else. */
async function markOwner(isolated: string, name: string, owner: PoolOwner) {
  const current = await readOwner(isolated, name)
  if (current && samePath(current.home, owner.home) && current.chatID === owner.chatID) return
  await mkdir(join(isolated, POOL_OWNERS_DIRNAME), { recursive: true })
  await writeFile(markerPath(isolated, name), `${JSON.stringify(owner)}\n`)
}

/** Whether an Arena home still has its store, so its pools still have an owner. */
async function homeExists(home: string) {
  return lstat(join(home, "arena.sqlite")).then(
    () => true,
    () => false,
  )
}

/**
 * When a directory last gained, lost or renamed an entry: its own mtime and its entries'. A pool
 * in use renames its slots every turn, and a staged clone is written as it is built.
 */
async function lastTouched(directory: string) {
  const own = await lstat(directory).catch(() => undefined)
  let newest = own?.mtimeMs ?? 0
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const stats = await lstat(join(directory, name)).catch(() => undefined)
    if (stats && stats.mtimeMs > newest) newest = stats.mtimeMs
  }
  return newest
}

/**
 * Take a tree out of its path and delete it. The rename frees the path at once; a tree Windows
 * refuses to move while a handle is open in it stays for the next sweep.
 */
async function removeTree(directory: string, isolated: string) {
  const grave = await discardTree(directory, join(isolated, TRASH_DIRNAME))
  if (!grave) return false
  await rm(grave, { recursive: true, force: true })
  return true
}

/**
 * Mark the pools this home's chats keep, then remove the pools under `checkouts` and those chats'
 * checkouts that no home owns, past their grace period, with no process working in them.
 *
 * `chats` is every chat in this home's store, archived ones included: an archived chat's leftover
 * pool is its own recovery's to finish, and is never taken for an orphan. `working` is every
 * process's working directory, or undefined when they could not be listed, in which case nothing
 * is removed.
 */
export async function sweepOrphanPools(input: {
  readonly home: string
  readonly chats: readonly { readonly id: string; readonly checkout: string; readonly archived: boolean }[]
  readonly checkouts: readonly string[]
  readonly working: () => Promise<readonly { readonly directory: string }[] | undefined>
  readonly now?: number
}): Promise<OrphanSweep> {
  const now = input.now ?? Date.now()
  const owned = new Set<string>()
  for (const chat of input.chats) {
    const pool = poolDirectory(chat.checkout, chat.id)
    owned.add(await identity(pool))
    if (chat.archived || !(await lstat(pool).catch(() => undefined))?.isDirectory()) continue
    await markOwner(isolatedRoot(chat.checkout), basename(pool), { home: input.home, chatID: chat.id })
  }

  const candidates: { directory: string; isolated: string; name: string; reason: OrphanReason; owner?: PoolOwner }[] =
    []
  const staged: { directory: string; isolated: string }[] = []
  const seen = new Set<string>()
  const checkouts = [...input.checkouts, ...input.chats.filter((chat) => !chat.archived).map((chat) => chat.checkout)]
  for (const checkout of checkouts) {
    const isolated = isolatedRoot(checkout)
    const key = await identity(isolated)
    if (seen.has(key)) continue
    seen.add(key)
    const entries = await readdir(isolated, { withFileTypes: true }).catch(() => [])
    const names = new Set(entries.map((entry) => entry.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || !POOL_NAME.test(entry.name)) continue
      const directory = join(isolated, entry.name)
      if (owned.has(await identity(directory))) continue
      const owner = await readOwner(isolated, entry.name)
      const touched = await lastTouched(directory)
      if (!owner) {
        if (now - touched >= UNMARKED_GRACE_MS)
          candidates.push({ directory, isolated, name: entry.name, reason: "unmarked" })
        continue
      }
      const ours = samePath(owner.home, input.home)
      if (!ours && (await homeExists(owner.home))) continue
      if (now - touched < MARKED_GRACE_MS) continue
      candidates.push({ directory, isolated, name: entry.name, reason: ours ? "unowned" : "home_gone", owner })
    }
    // A marker outlives its pool when a release or archive deleted the pool.
    for (const name of await readdir(join(isolated, POOL_OWNERS_DIRNAME)).catch(() => [] as string[])) {
      if (!names.has(name)) await rm(markerPath(isolated, name), { force: true })
    }
    const staging = join(isolated, STAGING_DIRNAME)
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      const directory = join(staging, name)
      if (now - (await lastTouched(directory)) >= STAGING_GRACE_MS) staged.push({ directory, isolated })
    }
  }
  if (candidates.length === 0 && staged.length === 0) return { pools: [], staged: [] }

  const working = await input.working()
  if (!working) {
    return {
      pools: candidates.map(({ directory, reason, owner }) => ({ directory, reason, owner, result: "busy" as const })),
      staged: [],
      unlisted: true,
    }
  }
  const busy = async (directory: string) => {
    const spellings = [resolve(directory), await identity(directory)]
    return working.some((entry) => spellings.some((root) => within(root, entry.directory)))
  }
  const pools: OrphanOutcome[] = []
  for (const { directory, isolated, name, reason, owner } of candidates) {
    if (await busy(directory)) {
      pools.push({ directory, reason, owner, result: "busy" })
      continue
    }
    if (!(await removeTree(directory, isolated))) {
      pools.push({ directory, reason, owner, result: "stuck" })
      continue
    }
    await rm(markerPath(isolated, name), { force: true })
    pools.push({ directory, reason, owner, result: "removed" })
  }
  const removedStaged: string[] = []
  for (const { directory } of staged) {
    if (await busy(directory)) continue
    await rm(directory, { recursive: true, force: true })
    removedStaged.push(directory)
  }
  return { pools, staged: removedStaged }
}

export * as ArenaOrphanPools from "./orphan-pools"
