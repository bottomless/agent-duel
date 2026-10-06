import { execFile as nodeExecFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import { constants, createReadStream } from "fs"
import { copyFile, cp, lstat, lutimes, mkdir, readdir, readlink, realpath, rm, symlink, writeFile } from "fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "path"
import { promisify } from "util"
import { cloneFile, cloneTree, type CloneMethod, type CloneOptions, type CopyMethod } from "@/util/copy-tree"
import { discardTree, TRASH_DIRNAME } from "@/util/discard-tree"
import { isolatedRoot, LOCAL_STATE_DIRNAME, localStatePath } from "@/worktree/layout"
import {
  decideIgnoredCopy,
  decideIgnoredTreeCopy,
  gitAdministrationPath,
  isArenaCopyExcluded,
  resolveArenaCopyPolicy,
  type CopyOmissionReason,
  type ResolvedArenaCopyPolicy,
} from "./copy-policy"
import { IGNORED_PATHS_COMMAND } from "./warm"

const execFile = promisify(nodeExecFile)

/**
 * The ignored content of a checkout, as the roots git lists rather than the files under them.
 *
 * A dependency tree is tens of thousands of files, and anything done per file — a stat, a
 * copy, a hash — takes minutes at that scale. Git's `--directory` listing collapses a wholly
 * ignored directory to one entry, and a copy-on-write clone moves that entry in one call, so
 * everything here works at the root level: a `node_modules` is one entry, cloned whole,
 * identified by its own inode, and never walked. The plain-copy fallback is the one place a
 * tree is measured, because it is the one place the size costs anything.
 */

export type SourceIdentity = {
  readonly device?: number
  readonly inode?: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly mode: number
}

export type CopyManifestEntry = {
  readonly relativePath: string
  readonly type: "file" | "directory" | "symlink" | "special"
  /** Measured only where the entry was copied rather than cloned; a cloned tree is never walked. */
  readonly logicalBytes: number
  readonly method?: CopyMethod
  readonly state: "copied" | "omitted"
  readonly omissionReason?: CopyOmissionReason
  readonly sourceIdentity?: SourceIdentity
}

export type CopyManifest = {
  readonly manifestID: string
  readonly canonicalRoot: string
  readonly resolvedPolicy: ResolvedArenaCopyPolicy
  readonly entries: readonly CopyManifestEntry[]
  readonly omittedCount: number
  readonly createdAt: string
}

/** A copy-on-write clone of a file or tree, or `undefined` where this filesystem has none. */
export type Clone = (source: string, target: string, options?: CloneOptions) => Promise<CloneMethod | undefined>

export type IgnoredContentSnapshotInput = {
  readonly canonical: string
  readonly policy?: unknown
  readonly defaults?: ResolvedArenaCopyPolicy
  /** Override the clone, for tests that model a filesystem without one. */
  readonly clone?: Clone
}

export type SeedCopyInput = {
  readonly targetRoot: string
  readonly manifest: CopyManifest
  readonly clone?: Clone
  /** Where a leftover tree at a target path is moved. Defaults to the contestant trash. */
  readonly trash?: string
  /** Maximum ignored roots cloned at once. Roots in a manifest never overlap. */
  readonly concurrency?: number
}

export type SeedCopyResult = {
  readonly entries: number
  readonly cloned: number
  readonly copied: number
}

export type SeedCleanupInput = {
  readonly targetRoot: string
  readonly manifest: CopyManifest
  readonly trash?: string
}

export type CopiedContentFingerprintInput = {
  readonly targetRoot: string
  readonly manifest: CopyManifest
}

export type IgnoredContentMatchInput = {
  readonly canonical: string
  readonly policy?: unknown
  readonly defaults?: ResolvedArenaCopyPolicy
  readonly manifest: CopyManifest
}

/**
 * A copied root of a kept worktree as its last seed or resync left it: the checkout's root as
 * the manifest recorded it, and the copy as it stood right after it was cloned. Process-local
 * on purpose. A root without a record is cloned again, which is always exact.
 */
export type SlotRootRecord = {
  readonly relativePath: string
  readonly type: CopyManifestEntry["type"]
  readonly sourceIdentity: SourceIdentity
  readonly targetIdentity: SourceIdentity
}

/**
 * What a filesystem watch saw of a set of roots over one window. `complete: false` means the
 * window as a whole went unobserved. A root in `changed` was written or was not watched.
 */
export type RootObservation = {
  readonly complete: boolean
  readonly changed: ReadonlySet<string>
  readonly reason?: string
  /** Roots in `changed` because nothing watched them, rather than because they were written, and why. */
  readonly unwatched?: ReadonlyMap<string, string>
  /**
   * For a written root, every path written under it, relative to the root. A root in `changed`
   * with no entry here was written somewhere the watch could not name, and reads as written
   * throughout.
   */
  readonly paths?: ReadonlyMap<string, ReadonlySet<string>>
}

export type IgnoredResyncPlanInput = {
  readonly targetRoot: string
  readonly manifest: CopyManifest
  /**
   * The worktree's ignored roots from `listIgnoredRoots`, taken after its tracked state was
   * restored. A listing that trims names hides a contestant's `.env ` behind the copied `.env`.
   */
  readonly slotRoots: readonly string[]
  /** The records the worktree's last seed or resync returned, by relative path. */
  readonly records?: ReadonlyMap<string, SlotRootRecord>
  /** The checkout's directory roots since the journal mark taken before that seed's manifest. */
  readonly canonical: RootObservation
  /** The worktree's directory roots since that seed or resync ended. */
  readonly slot: RootObservation
}

export type IgnoredResyncPlan = {
  readonly keep: string[]
  /**
   * Directory roots kept where they stand with only the paths written under them, in the
   * checkout or the worktree, brought to the checkout's state; the paths are relative to the root.
   */
  readonly patch: ReadonlyMap<string, readonly string[]>
  readonly reclone: string[]
  readonly discard: string[]
  /** Why each patched, recloned or discarded path was not kept. */
  readonly reasons: Record<string, string>
  /** The records carried over for the kept roots. */
  readonly records: ReadonlyMap<string, SlotRootRecord>
}

export type IgnoredResyncApplyInput = {
  readonly targetRoot: string
  readonly manifest: CopyManifest
  readonly plan: IgnoredResyncPlan
  readonly clone?: Clone
  /** Where discarded trees go. Defaults to the contestant trash. */
  readonly trash?: string
  /** Maximum roots discarded or cloned at once. */
  readonly concurrency?: number
  /**
   * Stops the resync between roots, and a root's clone between its children, rejecting with the
   * signal's reason. The worktree is then partly synced, and its records must not be trusted.
   */
  readonly signal?: AbortSignal
}

export type IgnoredResyncResult = {
  /** A record for every copied root the worktree now holds, for the next plan. */
  readonly records: Map<string, SlotRootRecord>
  readonly discarded: number
  readonly recloned: number
  readonly kept: number
  /** Roots patched in place, and the entries under them written again to do it. */
  readonly patched: number
  readonly patchedPaths: number
  /** Roots the plan patched that were cloned whole instead, and why. */
  readonly unpatched: Readonly<Record<string, string>>
}

type Stats = Awaited<ReturnType<typeof lstat>>

function identity(stats: Stats): SourceIdentity {
  return {
    device: typeof stats.dev === "number" ? stats.dev : undefined,
    inode: typeof stats.ino === "number" ? stats.ino : undefined,
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    mode: Number(stats.mode),
  }
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  )
}

/**
 * The same directory with its own mode, though entries in it may have changed: a child added,
 * removed or renamed moves a directory's mtime and ctime, and that alone is what a patch covers.
 * It cannot tell a root moved away and straight back. The journal reports that as an event on
 * the checkout's root, and misses it only when parcel folds the two moves into one update; the
 * checkout is the developer's, and nothing does that to a dependency tree by accident. A
 * worktree's root must also pass `entriesChangedLast`.
 */
function sameDirectory(left: SourceIdentity, right: SourceIdentity) {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode
}

/**
 * Whether a directory's own last change was to its entries. A child added, removed or renamed
 * sets its mtime and ctime together; the directory renamed, even away and straight back, or its
 * mode, owner or xattrs changed, moves its ctime alone. A child added after such a change hides
 * it here, and the slot watch covers that case by reading the event on the root itself.
 */
function entriesChangedLast(stats: Stats) {
  return stats.ctimeMs === stats.mtimeMs
}

/**
 * The most paths under one root a resync brings over one by one. Each is a few syscalls where
 * cloning the whole root is one call, so past this the root is cloned instead.
 */
export const PATCH_PATH_LIMIT = 256

function entryType(stats: Stats): CopyManifestEntry["type"] {
  if (stats.isFile()) return "file"
  if (stats.isDirectory()) return "directory"
  if (stats.isSymbolicLink()) return "symlink"
  return "special"
}

function pathInside(root: string, candidate: string) {
  const value = relative(root, candidate)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

/**
 * Git's `-z` listing of ignored roots, name for name.
 *
 * A `-z` entry is the path's exact bytes, so nothing is trimmed but the slash git puts after
 * a directory. Trimming would fold a contestant's ` notes.log` into `notes.log` and `.env `
 * into the copied `.env`, and a kept worktree would then carry that file into the next turn
 * under a root's name. A child listed beside its collapsed directory is dropped: the
 * directory is copied as one tree.
 */
export function parseIgnoredRoots(output: string): string[] {
  const roots = Array.from(
    new Set(
      output
        .split("\0")
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/\/+$/, ""))
        .map((entry) => (process.platform === "win32" ? entry.replaceAll("\\", "/") : entry))
        .filter((entry) => entry.length > 0)
        .filter((entry) => entry !== ".git" && !entry.startsWith(".git/"))
        .filter((entry) => entry !== LOCAL_STATE_DIRNAME && !entry.startsWith(`${LOCAL_STATE_DIRNAME}/`)),
    ),
  )
  return roots.filter((entry) => !roots.some((other) => other !== entry && entry.startsWith(`${other}/`)))
}

/** The ignored roots of a checkout or worktree, exactly as git names them. */
export async function listIgnoredRoots(directory: string): Promise<string[]> {
  const result = await execFile("git", [...IGNORED_PATHS_COMMAND, "--", "."], {
    cwd: directory,
    maxBuffer: 32 * 1024 * 1024,
  })
  return parseIgnoredRoots(result.stdout)
}

/**
 * Ignored roots that hold another registered worktree of the same repository. A nested
 * checkout is its own source state, and its `.git` link points outside the copied tree.
 */
async function nestedWorktreeRoots(canonical: string, roots: readonly string[]) {
  const listed = await execFile("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: canonical,
    maxBuffer: 32 * 1024 * 1024,
  })
  const registered = listed.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => resolve(entry.slice("worktree ".length)))
    .filter((worktree) => worktree !== canonical)
  return new Set(roots.filter((root) => registered.some((worktree) => pathInside(resolve(canonical, root), worktree))))
}

/** Where a root is cloned before it moves into a contestant directory; see `CloneOptions`. */
const STAGING_DIRNAME = ".staging"

/** The trash a contestant's cleared trees go to: the one the next turn's reclaim sweeps. */
function seedTrash(canonical: string) {
  return join(isolatedRoot(canonical), TRASH_DIRNAME)
}

/**
 * Whether the checkout's filesystem clones copy-on-write.
 *
 * Decided once per snapshot from a probe file under Arena's own excluded state directory,
 * because the probe has to sit on the checkout's volume and the temp directory may not.
 * With a clone available nothing is measured: the byte limits exist to bound a plain copy,
 * and a clone has no such cost.
 */
async function probeClone(canonical: string, clone: Clone) {
  const directory = localStatePath(canonical)
  const stem = join(directory, `clone-probe-${process.pid}-${randomUUID()}`)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(stem, "")
    return (await clone(stem, `${stem}.clone`)) !== undefined
  } catch {
    return false
  } finally {
    await rm(stem, { force: true }).catch(() => undefined)
    await rm(`${stem}.clone`, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Bytes under a tree, giving up as soon as the total is known to exceed `limit`. */
async function treeBytes(root: string, limit: number) {
  let total = 0
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        total += Number((await lstat(path).catch(() => undefined))?.size ?? 0)
        if (total > limit) return total
      }
    }
  }
  return total
}

function expectedCloneMethod(): CopyMethod {
  if (process.platform === "darwin") return "clonefile"
  if (process.platform === "linux") return "reflink"
  return "copy"
}

function omitted(
  relativePath: string,
  type: CopyManifestEntry["type"],
  reason: CopyOmissionReason,
  sourceIdentity?: SourceIdentity,
  logicalBytes = 0,
): CopyManifestEntry {
  return { relativePath, type, logicalBytes, state: "omitted", omissionReason: reason, sourceIdentity }
}

function copied(
  relativePath: string,
  type: CopyManifestEntry["type"],
  logicalBytes: number,
  method: CopyMethod,
  sourceIdentity: SourceIdentity,
): CopyManifestEntry {
  return { relativePath, type, logicalBytes, method, state: "copied", sourceIdentity }
}

function copiedEntries(manifest: CopyManifest) {
  return manifest.entries
    .filter((entry) => entry.state === "copied")
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
}

/**
 * Record the ignored roots both contestants will be seeded with. Nothing is copied here;
 * `copyIgnoredSeed` clones straight from the checkout into each contestant, so there is no
 * intermediate seed to build or to remove. Git's tracked and nonignored state is not part of
 * this; callers materialize it from ArenaGit.snapshotBase into the worktree first.
 */
export async function createIgnoredContentSnapshot(input: IgnoredContentSnapshotInput): Promise<CopyManifest> {
  const canonical = await realpath(input.canonical)
  const policy = resolveArenaCopyPolicy(input.policy, input.defaults)
  const clone = input.clone ?? cloneTree
  const roots = await listIgnoredRoots(canonical)
  const nested = await nestedWorktreeRoots(canonical, roots)
  const cloneable = roots.length > 0 && (await probeClone(canonical, clone))
  const method = cloneable ? expectedCloneMethod() : "copy"
  const entries: CopyManifestEntry[] = []
  let copiedBytes = 0

  for (const relativePath of roots) {
    const source = resolve(canonical, relativePath)
    if (!pathInside(canonical, source)) {
      entries.push(omitted(relativePath, "special", "outside_root"))
      continue
    }
    if (gitAdministrationPath(relativePath)) {
      entries.push(omitted(relativePath, "special", "git_admin"))
      continue
    }
    if (isArenaCopyExcluded(relativePath, policy)) {
      entries.push(omitted(relativePath, "special", "excluded"))
      continue
    }
    // After exclusions: an excluded root, such as the contestants' own, gains worktrees as it runs.
    if (nested.has(relativePath)) {
      entries.push(omitted(relativePath, "directory", "nested_worktree"))
      continue
    }
    let stats: Stats
    try {
      stats = await lstat(source)
    } catch {
      entries.push(omitted(relativePath, "special", "copy_failed"))
      continue
    }
    const sourceIdentity = identity(stats)
    const type = entryType(stats)
    if (type === "special") {
      entries.push(omitted(relativePath, type, "special_file", sourceIdentity))
      continue
    }
    if (type === "symlink") {
      const target = await readlink(source).catch(() => undefined)
      if (target === undefined) {
        entries.push(omitted(relativePath, type, "copy_failed", sourceIdentity))
        continue
      }
      const destination = isAbsolute(target) ? resolve(target) : resolve(dirname(source), target)
      if (!pathInside(canonical, destination)) {
        entries.push(omitted(relativePath, type, "outside_root", sourceIdentity))
        continue
      }
      entries.push(copied(relativePath, type, 0, "copy", sourceIdentity))
      continue
    }
    if (cloneable) {
      entries.push(copied(relativePath, type, type === "file" ? sourceIdentity.size : 0, method, sourceIdentity))
      continue
    }
    // A plain copy is the one path where size costs something, so it is the one path that
    // measures. A tree is walked only far enough to know it does not fit.
    const bytes =
      type === "file" ? sourceIdentity.size : await treeBytes(source, policy.ignoredTotalMaxBytes - copiedBytes)
    const decision =
      type === "file"
        ? decideIgnoredCopy(relativePath, bytes, copiedBytes, policy)
        : decideIgnoredTreeCopy(relativePath, bytes, copiedBytes, policy)
    if (decision.state === "omit") {
      entries.push(omitted(relativePath, type, decision.reason, sourceIdentity, bytes))
      continue
    }
    copiedBytes += bytes
    entries.push(copied(relativePath, type, bytes, "copy", sourceIdentity))
  }

  return {
    manifestID: randomUUID(),
    canonicalRoot: canonical,
    resolvedPolicy: policy,
    entries,
    omittedCount: entries.filter((entry) => entry.state === "omitted").length,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Whether the checkout still holds the ignored roots a manifest recorded.
 *
 * A root's identity is its own inode. For a tree that means a package added or removed
 * changes it and an edit deep inside does not — accepted, because a stale warm pair costs a
 * re-clone measured in seconds, and re-checking the tree would cost the walk the clone
 * exists to avoid. Omissions decided from the path alone still hold; the ones decided from
 * the tree's size cannot be re-checked without walking it and count as changed.
 */
export async function matchesIgnoredContentSnapshot(input: IgnoredContentMatchInput): Promise<boolean> {
  const canonical = await realpath(input.canonical)
  const policy = resolveArenaCopyPolicy(input.policy, input.defaults)
  if (canonical !== input.manifest.canonicalRoot) return false
  if (
    policy.ignoredFileMaxBytes !== input.manifest.resolvedPolicy.ignoredFileMaxBytes ||
    policy.ignoredTotalMaxBytes !== input.manifest.resolvedPolicy.ignoredTotalMaxBytes ||
    policy.exclude.length !== input.manifest.resolvedPolicy.exclude.length ||
    policy.exclude.some((pattern, index) => pattern !== input.manifest.resolvedPolicy.exclude[index])
  ) {
    return false
  }

  const roots = await listIgnoredRoots(canonical)
  const nested = await nestedWorktreeRoots(canonical, roots)
  if (roots.length !== input.manifest.entries.length) return false
  const entries = new Map(input.manifest.entries.map((entry) => [entry.relativePath, entry]))
  if (entries.size !== roots.length) return false

  for (const relativePath of roots) {
    const entry = entries.get(relativePath)
    if (!entry) return false
    if (entry.state === "omitted") {
      const reason = entry.omissionReason
      if (reason === "outside_root" || reason === "git_admin" || reason === "excluded" || reason === "special_file") {
        continue
      }
      if (reason === "nested_worktree" && nested.has(relativePath)) continue
      return false
    }
    if (nested.has(relativePath)) return false
    const stats = await lstat(join(canonical, relativePath)).catch(() => undefined)
    if (!stats) return false
    if (
      entryType(stats) !== entry.type ||
      !entry.sourceIdentity ||
      !sameIdentity(entry.sourceIdentity, identity(stats))
    ) {
      return false
    }
  }
  return true
}

/**
 * Take whatever sits at a seed path out of the way. A tree goes to the trash by rename and is
 * deleted behind the caller's back; anything smaller is just removed.
 */
async function discardExisting(target: string, trash: string) {
  const stats = await lstat(target).catch(() => undefined)
  if (!stats) return
  if (stats.isDirectory()) {
    const grave = await discardTree(target, trash)
    if (grave) {
      void rm(grave, { recursive: true, force: true }).catch(() => undefined)
      return
    }
  }
  await rm(target, { recursive: true, force: true })
}

/** Put one recorded root from the checkout at its place in a contestant directory. */
async function seedEntry(
  source: string,
  target: string,
  entry: CopyManifestEntry,
  clone: Clone,
  trash: string,
  signal?: AbortSignal,
) {
  // Whatever is already at the target is not from the base tree: git only collapses a
  // directory it tracks nothing under, and the worktree was reset to the base tree before
  // it was seeded. It is a previous seed that was not cleared, and it goes the way a
  // cleared seed goes rather than having this one land inside it.
  await discardExisting(target, trash)
  await mkdir(dirname(target), { recursive: true })
  if (entry.type === "symlink") {
    await symlink(await readlink(source), target)
    return "copied" as const
  }
  // Staged beside the trash: outside every worktree, so no watch sees the tree being built.
  if (await clone(source, target, { staging: join(dirname(trash), STAGING_DIRNAME), signal })) {
    return "cloned" as const
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true })
  return "copied" as const
}

/** Clone the recorded roots from the checkout into one contestant directory. */
export async function copyIgnoredSeed(input: SeedCopyInput): Promise<SeedCopyResult> {
  const canonical = input.manifest.canonicalRoot
  const targetRoot = resolve(input.targetRoot)
  const clone = input.clone ?? cloneTree
  const trash = input.trash ?? seedTrash(canonical)
  await mkdir(targetRoot, { recursive: true })
  const entries = copiedEntries(input.manifest)
  const results = await mapConcurrent(entries, input.concurrency ?? 4, async (entry) => {
    const source = join(canonical, entry.relativePath)
    const target = join(targetRoot, entry.relativePath)
    if (!pathInside(canonical, source) || !pathInside(targetRoot, target) || target === targetRoot) return undefined
    return await seedEntry(source, target, entry, clone, trash)
  })
  const cloned = results.filter((result) => result === "cloned").length
  const copiedCount = results.filter((result) => result === "copied").length
  return { entries: cloned + copiedCount, cloned, copied: copiedCount }
}

/**
 * Visit every value, a few at a time. The first failure stops the rest from starting, and it is
 * thrown only once the visits already running have finished: a caller that falls back to other
 * work on the same paths must not find this still writing there.
 */
async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  requestedConcurrency: number,
  visit: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  if (values.length === 0) return []
  const results = new Array<Output>(values.length)
  const concurrency = Math.max(1, Math.min(Math.floor(requestedConcurrency), values.length))
  let cursor = 0
  let failed = false
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (!failed && cursor < values.length) {
        const index = cursor++
        results[index] = await visit(values[index]!).catch((cause: unknown) => {
          failed = true
          throw cause
        })
      }
    }),
  )
  const failure = settled.find((outcome) => outcome.status === "rejected")
  if (failure) throw failure.reason
  return results
}

async function fileHash(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

/**
 * Fingerprint the seeded roots of a prepared worktree. Persisting this value lets restart
 * recovery detect drift instead of trusting the manifest ID alone.
 *
 * A file contributes its content and a tree only its path and mode. Hashing a tree's contents
 * was the per-file pass this module no longer makes; both sides are cloned from one source,
 * and the setup command that runs afterwards is expected to touch the tree anyway.
 */
export async function fingerprintCopiedContent(input: CopiedContentFingerprintInput): Promise<string> {
  const targetRoot = await realpath(resolve(input.targetRoot))
  const fingerprint = createHash("sha256")

  for (const entry of copiedEntries(input.manifest)) {
    const target = join(targetRoot, entry.relativePath)
    if (!pathInside(targetRoot, target) || target === targetRoot) {
      throw new Error(`Copied-content path escaped the worktree: ${entry.relativePath}`)
    }
    const parent = await realpath(dirname(target))
    if (!pathInside(targetRoot, parent)) {
      throw new Error(`Copied-content parent escaped the worktree: ${entry.relativePath}`)
    }
    const stats = await lstat(target)
    const actualType = entryType(stats)
    if (actualType !== entry.type) {
      throw new Error(`Copied-content type changed for ${entry.relativePath}`)
    }

    fingerprint.update(entry.relativePath)
    fingerprint.update("\0")
    fingerprint.update(actualType)
    fingerprint.update("\0")
    fingerprint.update(String(stats.mode & 0o7777))
    fingerprint.update("\0")
    if (actualType === "file") fingerprint.update(await fileHash(target))
    if (actualType === "symlink") fingerprint.update(await readlink(target))
    fingerprint.update("\0")
  }

  return `sha256:${fingerprint.digest("hex")}`
}

/**
 * Remove the roots an earlier seed put in a worktree before it is seeded again.
 *
 * Trees are renamed into the trash and unlinked in the background: the caller is a turn
 * waiting on the refresh, and a dependency tree is long enough to unlink to be felt.
 */
export async function clearIgnoredSeed(input: SeedCleanupInput): Promise<void> {
  const targetRoot = resolve(input.targetRoot)
  const trash = input.trash ?? seedTrash(input.manifest.canonicalRoot)
  const entries = copiedEntries(input.manifest).toSorted(
    (left, right) => right.relativePath.length - left.relativePath.length,
  )
  for (const entry of entries) {
    const target = join(targetRoot, entry.relativePath)
    if (!pathInside(targetRoot, target) || target === targetRoot) continue
    await discardExisting(target, trash)
  }
}

/**
 * APFS matches names regardless of case and Unicode normalization, so two roots that differ
 * only in those are one directory there. Folding everywhere costs, at worst, a clone of a
 * root that did not need one on a filesystem that tells them apart.
 */
function folded(relativePath: string) {
  return relativePath.normalize("NFC").toLowerCase()
}

/** Whether one root is the other, or lies inside it. */
function overlaps(left: string, right: string) {
  const a = folded(left)
  const b = folded(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Create a root's parent and confirm it is a directory of this worktree. A parent that
 * resolves through a symlink out of the worktree would have the discard and the clone act on
 * files that are not the contestant's. The nearest existing ancestor is checked before
 * anything is created, and the parent itself after.
 */
async function ensureParentInside(realRoot: string, targetRoot: string, target: string) {
  const parent = dirname(target)
  for (let candidate = parent; pathInside(targetRoot, candidate); candidate = dirname(candidate)) {
    const resolved = await realpath(candidate).catch(() => undefined)
    if (resolved === undefined) continue
    if (!pathInside(realRoot, resolved)) return false
    break
  }
  await mkdir(parent, { recursive: true })
  const resolved = await realpath(parent).catch(() => undefined)
  return resolved !== undefined && pathInside(realRoot, resolved)
}

/**
 * Why a watch cannot account for a directory root over its window, or nothing when it can:
 * nothing was written under it, or every path written is named. The watch's own reason goes
 * into the plan, so a clone caused by a watch that failed reads differently from one caused
 * by a write.
 */
function unobserved(observation: RootObservation, relativePath: string, side: string) {
  if (!observation.complete) {
    const why = observation.reason ? ` (${observation.reason})` : ""
    return `${side} was not watched for the whole window${why}`
  }
  if (!observation.changed.has(relativePath)) return undefined
  const unwatched = observation.unwatched?.get(relativePath)
  if (unwatched !== undefined) return `not watched in ${side} for the whole window (${unwatched})`
  if (observation.paths?.has(relativePath)) return undefined
  return `written to in ${side} since it was cloned`
}

function slotRootRecord(entry: CopyManifestEntry, stats: Stats): SlotRootRecord | undefined {
  if (!entry.sourceIdentity) return undefined
  return {
    relativePath: entry.relativePath,
    type: entry.type,
    sourceIdentity: entry.sourceIdentity,
    targetIdentity: identity(stats),
  }
}

/**
 * Record the copied roots of a worktree `copyIgnoredSeed` just seeded, so its next resync can
 * keep them. Taken before anything else writes into the worktree: a record vouches for the
 * copy exactly as it stands when recorded.
 */
export async function recordIgnoredSeed(input: {
  readonly targetRoot: string
  readonly manifest: CopyManifest
}): Promise<Map<string, SlotRootRecord>> {
  const targetRoot = resolve(input.targetRoot)
  const records = await Promise.all(
    copiedEntries(input.manifest).map(async (entry) => {
      const stats = await lstat(join(targetRoot, entry.relativePath)).catch(() => undefined)
      if (!stats || entryType(stats) !== entry.type) return undefined
      return slotRootRecord(entry, stats)
    }),
  )
  return new Map(
    records.filter((record) => record !== undefined).map((record) => [record.relativePath, record] as const),
  )
}

/**
 * Decide, root by root, what a kept worktree's ignored content needs to match a manifest.
 *
 * A fresh seed clones every root. A kept worktree already holds most of them, and a
 * dependency tree takes seconds to clone, so a root is kept, but only once every way it could
 * have drifted is ruled out. Anything unproven is cloned again, which is always exact:
 * - the copy is the one recorded after its clone: its own lstat identity is unchanged, which
 *   also covers a direct child added, removed or renamed;
 * - the checkout's root is the one that clone came from: the manifest's identity for it is
 *   the one recorded then;
 * - for a directory, nothing was written deeper inside on either side, which no root-level
 *   identity shows: both watches covered the whole window and report nothing under the root.
 * A symlink is recreated every time, which costs one syscall.
 *
 * A directory root written on either side is patched instead of cloned when both watches
 * covered the whole window, each named every path written under it on its side, and there are
 * few enough of them together. Each path is then taken from the checkout as it stands, whatever
 * either side did to it, so the watches only have to say where: a contestant's edit is undone,
 * what it added goes, what it deleted comes back. Either root may have moved, as long as it is
 * still the same directory with the same mode: a child added, removed or renamed moves it, and
 * the watch on that side names that child. A root whose identity moved with nothing named under
 * it on that side had its own metadata changed, and is cloned. The worktree's root must also
 * have changed last through its entries (`entriesChangedLast`), since a contestant's root moved
 * away and back, written through its other name, reports only its return; the slot watch reads
 * that return as written throughout. A name APFS matches differently from any fold here fails
 * the patch rather than steering a write, and a path made and removed within one delivery, which
 * parcel drops, leaves nothing behind. The patch only ever builds on a copy this process made.
 *
 * What is discarded comes from git's live listing of the worktree, never from the records,
 * so nothing git tracks goes: git only collapses a directory it tracks nothing under. No
 * `clean -x` either, which would unlink every file of every root one at a time.
 */
export async function planIgnoredResync(input: IgnoredResyncPlanInput): Promise<IgnoredResyncPlan> {
  const targetRoot = resolve(input.targetRoot)
  const entries = copiedEntries(input.manifest)
  const copiedPaths = new Set(entries.map((entry) => entry.relativePath))
  const omissions = new Map(
    input.manifest.entries
      .filter((entry) => entry.state === "omitted")
      .map((entry) => [entry.relativePath, entry.omissionReason] as const),
  )
  const listed = new Set(input.slotRoots)
  const discard: string[] = []
  const reclone = new Set<string>()
  const reasons: Record<string, string> = {}

  for (const root of listed) {
    if (copiedPaths.has(root)) continue
    const target = join(targetRoot, root)
    // Git lists nothing outside the worktree. A path that would escape it is not ours to
    // move, and the verification that follows the sync reports it.
    if (!pathInside(targetRoot, target) || target === targetRoot) continue
    discard.push(root)
    const omission = omissions.get(root)
    reasons[root] = omission ? `omitted from the checkout's copy (${omission})` : "not a root the checkout copies"
    // A root nested in or around a copied root means the two sides disagree on where the
    // ignored content starts, which after a restore to the same base only differing ignore
    // rules explain. The copied root is cloned whole rather than reconciled, and the
    // verification after the sync catches anything tracked that went with it.
    for (const entry of entries) {
      if (reclone.has(entry.relativePath) || !overlaps(root, entry.relativePath)) continue
      reclone.add(entry.relativePath)
      reasons[entry.relativePath] = `overlaps ${root}, which the checkout does not copy`
    }
  }
  // Git never lists Agent Duel's own state, so the filesystem is asked directly.
  if (await lstat(join(targetRoot, LOCAL_STATE_DIRNAME)).catch(() => undefined)) {
    discard.push(LOCAL_STATE_DIRNAME)
    reasons[LOCAL_STATE_DIRNAME] = "Agent Duel state never belongs to a contestant"
  }

  const realRoot = await realpath(targetRoot).catch(() => targetRoot)
  /** Nothing to keep the root as it stands, the paths to patch under it, or why it is cloned. */
  const decide = async (
    entry: CopyManifestEntry,
    record: SlotRootRecord | undefined,
  ): Promise<undefined | { readonly patch: readonly string[]; readonly by: string } | { readonly reason: string }> => {
    const reclone = (reason: string) => ({ reason })
    if (entry.type === "symlink") return reclone("a symlink root is always recreated")
    if (!listed.has(entry.relativePath)) return reclone("not listed as ignored in the worktree")
    if (!record) return reclone("no record of an earlier clone")
    if (record.type !== entry.type) return reclone(`was cloned as a ${record.type}`)
    const directory = entry.type === "directory"
    if (!entry.sourceIdentity) return reclone("changed in the checkout since it was cloned")
    const checkoutMoved = !sameIdentity(entry.sourceIdentity, record.sourceIdentity)
    if (checkoutMoved && !(directory && sameDirectory(entry.sourceIdentity, record.sourceIdentity))) {
      return reclone("changed in the checkout since it was cloned")
    }
    const target = join(targetRoot, entry.relativePath)
    const stats = await lstat(target).catch(() => undefined)
    if (!stats) return reclone("missing from the worktree")
    if (entryType(stats) !== entry.type) return reclone(`no longer a ${entry.type} in the worktree`)
    const current = identity(stats)
    const worktreeMoved = !sameIdentity(current, record.targetIdentity)
    if (worktreeMoved && !(directory && sameDirectory(current, record.targetIdentity) && entriesChangedLast(stats))) {
      return reclone("changed in the worktree since it was cloned")
    }
    const parent = await realpath(dirname(target)).catch(() => undefined)
    if (parent === undefined || !pathInside(realRoot, parent)) return reclone("resolves outside the worktree")
    if (!directory) return undefined
    const unseen =
      unobserved(input.canonical, entry.relativePath, "the checkout") ??
      unobserved(input.slot, entry.relativePath, "the worktree")
    if (unseen !== undefined) return reclone(unseen)
    const fromCheckout = input.canonical.paths?.get(entry.relativePath) ?? new Set<string>()
    const fromWorktree = input.slot.paths?.get(entry.relativePath) ?? new Set<string>()
    if (checkoutMoved && fromCheckout.size === 0) return reclone("changed in the checkout since it was cloned")
    if (worktreeMoved && fromWorktree.size === 0) return reclone("changed in the worktree since it was cloned")
    // A path under another written path goes with it: a new package is one entry, not its files.
    const written = outermost([...fromCheckout, ...fromWorktree])
    if (written.length === 0) return undefined
    if (written.length > PATCH_PATH_LIMIT) {
      return reclone(`${written.length} paths written under it, more than are brought over one by one`)
    }
    const sides = [
      fromCheckout.size > 0 ? "the checkout" : undefined,
      fromWorktree.size > 0 ? "the worktree" : undefined,
    ]
    return { patch: written.sort(), by: sides.filter((side) => side !== undefined).join(" and ") }
  }

  const keep: string[] = []
  const patch = new Map<string, readonly string[]>()
  const records = new Map<string, SlotRootRecord>()
  const decisions = await Promise.all(
    entries.map(async (entry) => {
      if (reclone.has(entry.relativePath)) return undefined
      const record = input.records?.get(entry.relativePath)
      return { entry, record, decision: await decide(entry, record) }
    }),
  )
  for (const decided of decisions) {
    if (!decided) continue
    const relativePath = decided.entry.relativePath
    if (decided.decision === undefined && decided.record) {
      keep.push(relativePath)
      records.set(relativePath, decided.record)
      continue
    }
    if (decided.decision && "patch" in decided.decision) {
      const count = decided.decision.patch.length
      patch.set(relativePath, decided.decision.patch)
      reasons[relativePath] = `patched: ${count} ${count === 1 ? "path" : "paths"} written in ${decided.decision.by}`
      continue
    }
    reclone.add(relativePath)
    reasons[relativePath] = decided.decision?.reason ?? "no record of an earlier clone"
  }

  return {
    keep,
    patch,
    reclone: entries.map((entry) => entry.relativePath).filter((relativePath) => reclone.has(relativePath)),
    discard,
    reasons,
    records,
  }
}

/**
 * The paths no other path of the set lies under. Folded, so two spellings of one name on a
 * filesystem that ignores case are one entry; `patchEntry` writes every spelling of it.
 */
function outermost(paths: Iterable<string>) {
  const kept = new Map<string, string>()
  for (const under of Array.from(paths).sort((left, right) => left.length - right.length)) {
    const key = folded(under)
    let covered = kept.has(key)
    for (let cut = key.lastIndexOf("/"); cut > 0 && !covered; cut = key.lastIndexOf("/", cut - 1)) {
      covered = kept.has(key.slice(0, cut))
    }
    if (!covered) kept.set(key, under)
  }
  return Array.from(kept.values())
}

/**
 * The entries a patch writes again: each path written, or the nearest ancestor of it that is not
 * a plain directory on both sides, since a path cannot be brought over through a symlink, a file
 * or a directory one side lacks. A path under another that is written again goes with it.
 */
async function patchEntries(canonicalRoot: string, targetRoot: string, paths: readonly string[]) {
  const directoryOnBoth = new Map<string, Promise<boolean>>()
  const plainDirectory = (under: string) => {
    let known = directoryOnBoth.get(under)
    if (!known) {
      known = Promise.all([lstat(join(canonicalRoot, under)), lstat(join(targetRoot, under))])
        .then(([left, right]) => left.isDirectory() && right.isDirectory())
        .catch(() => false)
      directoryOnBoth.set(under, known)
    }
    return known
  }
  const resolved = await Promise.all(
    paths.map(async (written) => {
      const segments = written.split("/")
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error(`Patched path is not a plain relative path: ${JSON.stringify(written)}`)
      }
      for (let depth = 1; depth < segments.length; depth++) {
        const ancestor = segments.slice(0, depth).join("/")
        if (!(await plainDirectory(ancestor))) return ancestor
      }
      return written
    }),
  )
  return outermost(resolved)
}

/**
 * Bring one entry of a patched root to the checkout's state: every spelling of its name the
 * worktree holds goes, and every spelling the checkout holds is cloned in, so a case-only rename
 * lands under the checkout's spelling and a filesystem that tells spellings apart keeps both.
 * Nothing is written into a name that still answers: a spelling the fold here does not match but
 * the filesystem does would otherwise be written through, so it fails the patch instead.
 */
async function patchEntry(input: {
  readonly canonicalRoot: string
  readonly targetRoot: string
  readonly under: string
  readonly clone: Clone
  readonly trash: string
  readonly listing: (directory: string) => Promise<ReadonlyMap<string, readonly string[]>>
}) {
  const parent = dirname(input.under) === "." ? "" : dirname(input.under)
  const name = folded(input.under.slice(input.under.lastIndexOf("/") + 1))
  const matching = async (root: string) => (await input.listing(join(root, parent))).get(name) ?? []
  const [stale, current] = await Promise.all([matching(input.targetRoot), matching(input.canonicalRoot)])
  const into = join(input.targetRoot, parent)
  for (const entry of stale) await discardExisting(join(into, entry), input.trash)
  for (const entry of current) {
    const source = join(input.canonicalRoot, parent, entry)
    const target = join(into, entry)
    const stats = await lstat(source)
    const type = entryType(stats)
    if (type === "special") throw new Error(`Cannot patch a special file: ${input.under}`)
    if (await lstat(target).catch(() => undefined)) {
      throw new Error(`Patched path is still taken in the worktree: ${JSON.stringify(input.under)}`)
    }
    if (type === "symlink") {
      await symlink(await readlink(source), target)
      continue
    }
    if (type === "file") {
      if (await cloneFile(source, target)) continue
      // A whole-root clone keeps each file's times, so a patched file does too.
      await copyFile(source, target, constants.COPYFILE_EXCL)
      await lutimes(target, stats.atime, stats.mtime)
      continue
    }
    if (!(await input.clone(source, target))) await cp(source, target, { recursive: true, verbatimSymlinks: true })
  }
}

/**
 * Patch one kept directory root: each entry `patchEntries` names is written again from the
 * checkout, so whatever either side did there, the worktree ends up with what the checkout has.
 * Returns how many entries were written.
 */
async function patchRoot(input: {
  readonly canonical: string
  readonly targetRoot: string
  readonly realRoot: string
  readonly relativePath: string
  readonly paths: readonly string[]
  readonly clone: Clone
  readonly trash: string
  readonly concurrency: number
}) {
  const canonicalRoot = join(input.canonical, input.relativePath)
  const targetRoot = join(input.targetRoot, input.relativePath)
  // Checked by the plan too; the apply may come a moment later.
  const resolvedRoot = await realpath(targetRoot)
  if (!pathInside(input.realRoot, resolvedRoot) || resolvedRoot === input.realRoot) {
    throw new Error(`Patched root resolves outside the worktree: ${input.relativePath}`)
  }
  const entries = await patchEntries(canonicalRoot, targetRoot, input.paths)
  const listings = new Map<string, Promise<ReadonlyMap<string, readonly string[]>>>()
  // Only what `patchEntries` proved a plain directory on both sides is listed, and each entry
  // changes names under its own folded spelling only, so one listing per directory serves all.
  // Kept by folded name, since a dependency directory can hold tens of thousands.
  const listing = (directory: string) => {
    let names = listings.get(directory)
    if (!names) {
      names = readdir(directory).then((entries) => {
        const byName = new Map<string, string[]>()
        for (const entry of entries) byName.set(folded(entry), [...(byName.get(folded(entry)) ?? []), entry])
        return byName
      })
      listings.set(directory, names)
    }
    return names
  }
  await mapConcurrent(entries, input.concurrency, (under) =>
    patchEntry({ canonicalRoot, targetRoot, under, clone: input.clone, trash: input.trash, listing }),
  )
  return entries.length
}

/**
 * Carry out a resync plan: discard, then patch, then clone, then record.
 *
 * Discards go first, so a clone never lands inside a tree that is about to leave. A kept root
 * is looked at once more, since the plan may be a moment old, and cloned again if it moved.
 * A patched root is looked at the same way, and one whose patch fails partway is cloned whole,
 * which leaves it exact whatever the patch got to. A copied root the plan did not account for
 * is cloned too, so the records returned always cover the whole manifest.
 */
export async function applyIgnoredResync(input: IgnoredResyncApplyInput): Promise<IgnoredResyncResult> {
  const canonical = input.manifest.canonicalRoot
  const targetRoot = resolve(input.targetRoot)
  const realRoot = await realpath(targetRoot)
  const clone = input.clone ?? cloneTree
  const trash = input.trash ?? seedTrash(canonical)
  const concurrency = input.concurrency ?? 4
  const entries = new Map(copiedEntries(input.manifest).map((entry) => [entry.relativePath, entry] as const))
  for (const relativePath of [...input.plan.keep, ...input.plan.patch.keys(), ...input.plan.reclone]) {
    if (!entries.has(relativePath)) {
      throw new Error(`Resync plan names ${relativePath}, which the manifest does not copy`)
    }
  }

  // The plan's listing was taken moments ago with nothing running in the worktree, so a listed
  // path that is not there means the listing and the disk disagree on a name. Skipping it
  // could leave the file git meant in place, so the resync fails instead.
  const discarded = await mapConcurrent(input.plan.discard, concurrency, async (relativePath) => {
    input.signal?.throwIfAborted()
    const target = join(targetRoot, relativePath)
    if (!pathInside(targetRoot, target) || target === targetRoot) {
      throw new Error(`Discarded path escaped the worktree: ${relativePath}`)
    }
    const parent = await realpath(dirname(target)).catch(() => undefined)
    if (parent !== undefined && !pathInside(realRoot, parent)) {
      throw new Error(`Discarded path resolves outside the worktree: ${relativePath}`)
    }
    if (parent === undefined || !(await lstat(target).catch(() => undefined))) {
      throw new Error(`Resync plan discards ${JSON.stringify(relativePath)}, which is not in the worktree`)
    }
    await discardExisting(target, trash)
    return true
  })

  const kept = new Map<string, SlotRootRecord>()
  await Promise.all(
    input.plan.keep.map(async (relativePath) => {
      const entry = entries.get(relativePath)
      const record = input.plan.records.get(relativePath)
      const stats = await lstat(join(targetRoot, relativePath)).catch(() => undefined)
      if (!entry || entry.type === "symlink" || !record || !stats || entryType(stats) !== entry.type) return
      if (sameIdentity(identity(stats), record.targetIdentity)) kept.set(relativePath, record)
    }),
  )
  const patched = new Map<string, SlotRootRecord>()
  const unpatched: Record<string, string> = {}
  let patchedPaths = 0
  // One root at a time, each spreading its entries over the concurrency: roots rarely number
  // more than a few, and entries under one root can be hundreds.
  for (const [relativePath, paths] of input.plan.patch) {
    input.signal?.throwIfAborted()
    const entry = entries.get(relativePath)
    const target = join(targetRoot, relativePath)
    const before = await lstat(target).catch(() => undefined)
    if (!entry || entry.type !== "directory" || !before?.isDirectory()) {
      unpatched[relativePath] = "no longer a directory in the worktree"
      continue
    }
    const written = await patchRoot({
      canonical,
      targetRoot,
      realRoot,
      relativePath,
      paths,
      clone,
      trash,
      concurrency,
    }).catch((cause: unknown) => {
      input.signal?.throwIfAborted()
      unpatched[relativePath] = `patch failed: ${cause instanceof Error ? cause.message : String(cause)}`
      return undefined
    })
    if (written === undefined) continue
    const stats = await lstat(target).catch(() => undefined)
    const record = stats && entryType(stats) === "directory" ? slotRootRecord(entry, stats) : undefined
    if (!record || stats?.ino !== before.ino) {
      unpatched[relativePath] = "replaced while it was patched"
      continue
    }
    patched.set(relativePath, record)
    patchedPaths += written
  }
  const reclone = Array.from(entries.values()).filter(
    (entry) => !kept.has(entry.relativePath) && !patched.has(entry.relativePath),
  )
  const cloned = await mapConcurrent(reclone, concurrency, async (entry) => {
    input.signal?.throwIfAborted()
    const source = join(canonical, entry.relativePath)
    const target = join(targetRoot, entry.relativePath)
    if (!pathInside(canonical, source) || !pathInside(targetRoot, target) || target === targetRoot) {
      throw new Error(`Copied-content path escaped the worktree: ${entry.relativePath}`)
    }
    if (!(await ensureParentInside(realRoot, targetRoot, target))) {
      throw new Error(`Copied-content parent escaped the worktree: ${entry.relativePath}`)
    }
    await seedEntry(source, target, entry, clone, trash, input.signal)
    const stats = await lstat(target)
    if (entryType(stats) !== entry.type) throw new Error(`Copied-content type changed for ${entry.relativePath}`)
    return slotRootRecord(entry, stats)
  })

  const fresh = new Map(
    cloned.filter((record) => record !== undefined).map((record) => [record.relativePath, record] as const),
  )
  const records = new Map<string, SlotRootRecord>()
  for (const relativePath of entries.keys()) {
    const record = kept.get(relativePath) ?? patched.get(relativePath) ?? fresh.get(relativePath)
    if (record) records.set(relativePath, record)
  }
  return {
    records,
    discarded: discarded.length,
    recloned: reclone.length,
    kept: kept.size,
    patched: patched.size,
    patchedPaths,
    unpatched,
  }
}

/**
 * Seed a worktree the daemon just created with the source checkout's ignored content.
 *
 * The same clone a contestant gets, applied to a Paseo worktree before its setup command
 * runs. The policy is the source checkout's `paseo.json`, as it is for a battle. There is
 * no manifest to keep: the worktree is not refreshed from this seed later.
 */
export async function seedWorktreeIgnoredContent(input: {
  readonly source: string
  readonly target: string
}): Promise<SeedCopyResult> {
  const policy = await Bun.file(join(input.source, "paseo.json"))
    .json()
    .catch(() => undefined)
  const manifest = await createIgnoredContentSnapshot({ canonical: input.source, policy })
  return await copyIgnoredSeed({ targetRoot: input.target, manifest })
}

export * as ArenaCopySnapshot from "./copy-snapshot"
