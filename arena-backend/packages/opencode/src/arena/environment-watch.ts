// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { randomUUID } from "crypto"
import { lstatSync } from "fs"
import { lstat, mkdir, realpath, rm } from "fs/promises"
import os from "os"
import path from "path"
import type { RootObservation } from "./copy-snapshot"

/**
 * Whether a warm pair's ignored content has been watched continuously since it was cloned.
 *
 * The manifest check this backs up asks whether a root's own inode, size and mtime still
 * match. That question cannot see a file edited deep inside a cloned tree: writing
 * `node_modules/pkg/lib/x.js` leaves `node_modules` itself untouched, and copy-on-write
 * means the warm clone keeps the old blocks. Answering it by walking the tree would cost
 * the 100k-entry walk the clone exists to avoid, so the answer has to come from the
 * filesystem telling us as it happens.
 *
 * The rule is coverage, not liveness: a pair is reusable only while an unbroken record
 * exists for the whole window between cloning it and leasing it. Everything that breaks
 * that record -- a subscription that never started, an error mid-stream, a daemon restart --
 * is the same answer, `complete: false`, and the caller re-clones.
 *
 * Only the ignored directory roots are watched, one subscription each, and never the
 * checkout itself. A checkout-wide subscription sees Agent Duel writing both contestant
 * environments inside it, and a few hundred thousand file creations is enough for FSEvents
 * to stop attributing them and demand a rescan -- the watcher throwing away pairs because
 * of its own clones. Ignored *file* roots are left out because a file's own identity
 * already changes when it is edited, which is the check this supplements, not replaces.
 */
export type Observation = {
  /** Ignored roots reported changed. Empty and complete means the pair is still good. */
  readonly changed: ReadonlySet<string>
  /** False whenever any part of the window went unobserved. Never reuse a pair on false. */
  readonly complete: boolean
  readonly reason?: string
}

export type BeginInput = {
  readonly key: string
  readonly canonical: string
  /** Ignored roots to watch. Anything that is not a directory is skipped. */
  readonly roots: readonly string[]
}

/**
 * Deliberately narrower than the parcel implementation. A deployment whose canonical state
 * cannot be edited underneath it -- a server materializing contestants from a pushed ref --
 * supplies `alwaysObserved` instead, and one with no watcher at all gets `neverObserved`
 * and pays a re-clone per send.
 */
export type EnvironmentWatch = {
  readonly begin: (input: BeginInput) => Promise<void>
  /** Adopt the manifest's roots once it is built, covering any that appeared since `begin`. */
  readonly retarget: (key: string, roots: readonly string[]) => Promise<void>
  readonly settle: (key: string) => Observation
  readonly stop: (key: string) => Promise<void>
}

const unobserved = (reason: string): Observation => ({ changed: new Set(), complete: false, reason })

/** No record means no coverage. A restart lands here, which is why it re-clones. */
export const NO_RECORD = unobserved("no observation record for this generation")

type Record = {
  readonly key: string
  readonly canonical: string
  /** One subscription per watched root, keyed by the root's checkout-relative path. */
  readonly subscriptions: Map<string, ParcelWatcher.AsyncSubscription>
  readonly changed: Set<string>
  complete: boolean
  reason?: string
}

const backend = (): ParcelWatcher.BackendType | undefined => {
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
  if (process.platform === "win32") return "windows"
  return undefined
}

let binding: typeof import("@parcel/watcher") | undefined | null

/**
 * The package first, then the platform binding the way the core watcher resolves it. The
 * package is what resolves under `bun run` and the tests; the explicit platform require is
 * what survives bundling, where the optional dependency is not reachable by name.
 */
function watcher() {
  if (binding !== undefined) return binding ?? undefined
  binding = null
  try {
    const parcel = require("@parcel/watcher") as typeof import("@parcel/watcher")
    if (typeof parcel?.subscribe === "function") {
      binding = parcel
      return binding
    }
  } catch {
    // fall through to the platform binding
  }
  try {
    const platform = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`,
    )
    binding = createWrapper(platform) as typeof import("@parcel/watcher")
  } catch {
    binding = null
  }
  return binding ?? undefined
}

/**
 * Parcel runs every FSEvents stream of the process on one run loop, and a run loop returns
 * once its last source is gone. Parcel stops a stream itself when its root is deleted. If
 * that was the last stream on the loop, the loop's thread ends while the backend stays
 * registered to whatever subscriptions remain, and every stream started on it afterwards is
 * silently dead, for any directory, until they are all unsubscribed.
 *
 * Two things keep that from happening. Every subscription here lets go of a stream parcel
 * stopped, so no subscription outlives its stream. And while anything here is watched, one
 * more stream sits on an empty directory of our own, so the loop always has a source left.
 */
type Anchor = {
  directory?: string
  subscription?: ParcelWatcher.AsyncSubscription
  ready: Promise<void>
}

let anchorHolders = 0
let anchor: Anchor | undefined

async function dropAnchor(current: Anchor, rootDeleted = false) {
  if (anchor === current) anchor = undefined
  const { subscription, directory } = current
  current.subscription = undefined
  await letGo(subscription, rootDeleted)
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Parcel stops and releases a stream itself when it reports the stream's root deleted, on its
 * run-loop thread, after handing the delete to us and without the lock `unsubscribe` takes
 * (FSEventsBackend.cc). An unsubscribe that lands in between releases the stream a second time
 * and aborts the process with `CFRelease() called with NULL`. Once parcel has stopped the
 * stream, unsubscribing only takes the subscription off the backend, which still has to happen
 * (see `Anchor`), so it waits this long.
 */
const ROOT_DELETED_LET_GO_MS = 1_000

/** Unsubscribes in flight or put off. The anchor is dropped only after them. */
const lettingGo = new Set<Promise<void>>()

/** Resolves once the subscription is off the backend and its stream is stopped. */
function letGo(subscription: ParcelWatcher.AsyncSubscription | undefined, rootDeleted = false): Promise<void> {
  if (!subscription) return Promise.resolve()
  const wait = rootDeleted
    ? new Promise<void>((resolve) => setTimeout(resolve, ROOT_DELETED_LET_GO_MS))
    : Promise.resolve()
  const job = wait.then(() => subscription.unsubscribe()).catch(() => undefined)
  lettingGo.add(job)
  void job.finally(() => lettingGo.delete(job))
  return job
}

function ensureAnchor(parcel: typeof import("@parcel/watcher"), chosen: ParcelWatcher.BackendType) {
  if (chosen !== "fs-events" || anchorHolders === 0) return Promise.resolve()
  if (anchor) return anchor.ready
  const current: Anchor = { ready: Promise.resolve() }
  anchor = current
  current.ready = (async () => {
    // Resolved, so the delete of the directory itself is recognized when the backend reports it.
    const directory = path.join(await realpath(os.tmpdir()), `agent-duel-watch-anchor-${process.pid}-${randomUUID()}`)
    current.directory = directory
    await mkdir(directory, { recursive: true })
    current.subscription = await parcel.subscribe(
      directory,
      (error, events) => {
        if (error) void dropAnchor(current)
        else if (events.some((event) => event.type === "delete" && isRoot(event.path, directory))) {
          void dropAnchor(current, true)
        }
      },
      { backend: chosen },
    )
  })().catch(() => {
    if (anchor === current) anchor = undefined
    if (current.directory) void rm(current.directory, { recursive: true, force: true }).catch(() => undefined)
  })
  return current.ready
}

function holdAnchor() {
  anchorHolders++
}

async function releaseAnchor() {
  anchorHolders = Math.max(0, anchorHolders - 1)
  const current = anchor
  if (anchorHolders > 0 || !current) return
  anchor = undefined
  await current.ready
  await Promise.all(Array.from(lettingGo))
  // A holder that came during the awaits made an anchor of its own. The old one goes once the new
  // one is subscribed, so the run loop is never left without a source in between.
  const replacement = anchor as Anchor | undefined
  await replacement?.ready
  await dropAnchor(current)
}

export function createEnvironmentWatch(): EnvironmentWatch {
  const records = new Map<string, Record>()

  const stop = async (key: string) => {
    const record = records.get(key)
    if (!record) return
    records.delete(key)
    await Promise.all(Array.from(record.subscriptions.values()).map((subscription) => letGo(subscription)))
    await releaseAnchor()
  }

  /** Watch one root. A root that is not a directory needs no watch and is not an error. */
  const watchRoot = async (record: Record, root: string) => {
    if (record.subscriptions.has(root)) return
    const parcel = watcher()
    const chosen = backend()
    if (!parcel || !chosen) {
      record.complete = false
      record.reason = "no filesystem watcher backend on this platform"
      return
    }
    const directory = path.join(record.canonical, root)
    const stats = await lstat(directory).catch(() => undefined)
    if (!stats?.isDirectory()) return
    // Parcel stops the stream once the root itself is deleted. The root is reported by then;
    // the subscription is let go so it does not hold the backend (see `Anchor`).
    let stopped = false
    try {
      await ensureAnchor(parcel, chosen)
      const subscription = await parcel.subscribe(
        directory,
        (error, events) => {
          const current = records.get(record.key)
          if (!current) return
          if (error) {
            current.complete = false
            current.reason = error.message
          } else {
            // The subscription is the root, so whatever it reports belongs to that root and
            // the paths themselves are of no further interest.
            current.changed.add(root)
          }
          if (!events.some((event) => event.type === "delete" && isRoot(event.path, directory))) return
          stopped = true
          const own = record.subscriptions.get(root)
          record.subscriptions.delete(root)
          void letGo(own, true)
        },
        { backend: chosen },
      )
      if (stopped) {
        void letGo(subscription, true)
        return
      }
      record.subscriptions.set(root, subscription)
    } catch (cause) {
      record.complete = false
      record.reason = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const begin = async (input: BeginInput) => {
    await stop(input.key)
    // Resolved, because the backend reports resolved paths and a temp or symlinked checkout
    // resolves elsewhere. The manifest resolves its roots the same way.
    const canonical = await realpath(input.canonical).catch(() => input.canonical)
    const record: Record = {
      key: input.key,
      canonical,
      subscriptions: new Map(),
      changed: new Set(),
      complete: true,
    }
    records.set(input.key, record)
    holdAnchor()
    for (const root of input.roots) await watchRoot(record, root)
  }

  const retarget = async (key: string, roots: readonly string[]) => {
    const record = records.get(key)
    if (!record) return
    for (const root of roots) await watchRoot(record, root)
  }

  const settle = (key: string): Observation => {
    const record = records.get(key)
    if (!record) return NO_RECORD
    return {
      changed: new Set(record.changed),
      complete: record.complete,
      ...(record.reason ? { reason: record.reason } : {}),
    }
  }

  return { begin, retarget, settle, stop }
}

/**
 * Watches over time, for worktrees that are kept between turns.
 *
 * A kept worktree keeps a copied root as it stands only while nothing was written under it, on
 * either side, since it was cloned, and patches it in place when every path written is named
 * (see `planIgnoredResync`). Two watches answer that. The journal
 * follows the checkout's roots for the life of a chat, and any window is a mark: a position
 * in its sequence of events. The slot watch follows one worktree's roots from the end of its
 * sync to the start of the next one.
 *
 * Both keep the rule above: coverage, not liveness. A root without a live stream for the
 * whole window counts as changed.
 *
 * Streams are few on purpose. FSEvents allows a process about 512, shared with OpenCode's own
 * file watcher, and a stream per root per worktree runs out after a couple of chats on a
 * monorepo. So a slot watch has one stream, on the worktree. The journal cannot do the same
 * with the checkout: the contestant worktrees live inside it, and one dependency install
 * there floods any stream above it until FSEvents drops events, excluded path or not. It
 * has one stream per top-level directory holding a root, shared by every chat on the
 * checkout. A stream above a root also sees the root's ancestors, which is the only way to
 * learn that a directory was renamed away and back while something was written through its
 * other name: the root's own identity does not change.
 *
 * Facts about the backend that shape the rest:
 * - Parcel stops a stream, with no error, once the directory it watches is deleted or moved
 *   away, and a directory moved away and straight back reaches the stream as a create of
 *   itself and nothing else. Either, an error, or a directory that is no longer the one the
 *   stream was opened on takes every root under the stream out of coverage. The journal's
 *   `retarget` opens the stream again.
 * - Parcel shares one native watcher between every subscription of the same directory and
 *   options, so subscribing again to a directory whose stream stopped could attach to that
 *   dead watcher while anybody else still held it. Every stream here gets options of its own,
 *   an ignore path nothing will ever create.
 * - A stream parcel stopped can take the whole backend down with it; see `Anchor`.
 * - Parcel remembers every path a native watcher has reported, with its mtime, and drops a later
 *   event on that path that carries the same mtime (FSEventsBackend.cc). A chmod, xattr or owner
 *   change is such an event, and so is a directory moved away and straight back, which keeps its
 *   mtime. A stream that lives as long as a chat would hide a mode-only change to any file it
 *   reported earlier in that chat, so the journal renews its streams before every mark; see
 *   `renewStream`. Below a root this costs nothing: a path is only remembered once it was
 *   reported, and a reported path is brought over whole, whatever happened to it afterwards.
 * - A root moved away and straight back, or its own mode, owner or xattrs changed, reaches a
 *   stream as an event on the root itself; a child added or removed is reported under its own
 *   path and nothing else. Both sides' roots may move for a patch, as a child added or removed
 *   moves them, so an event on a root itself is how a watch learns what the root's identity
 *   alone cannot tell apart. In the journal any such event reads the root as written throughout.
 * - FSEvents replays the last few milliseconds before a stream starts. A tree cloned just
 *   before the slot watch begins arrives as a create of the root itself, 10-50 ms after the
 *   stream starts. So in a worktree an event on a root itself is a change only when the root's
 *   lstat identity is no longer the one taken when its coverage began. The replay also leaves
 *   the root remembered with its real mtime, after which parcel drops the move of a root away
 *   and straight back, so a slot watch that let a replay through takes a new native watcher
 *   once the replay is over (`REPLAY_MS`). A stream's own directory was made long before the
 *   stream, so a create of it is taken at its word.
 */

/**
 * The most streams the watches here hold at once, so they never take a stream OpenCode's own
 * watcher needs. Past it the stream attached longest ago is stopped for the new one: an idle
 * chat's worktree, most likely, which re-clones its roots when it is next used.
 */
const STREAM_BUDGET = 256
let streamUse = 0

type StreamListener = {
  readonly events: (events: readonly ParcelWatcher.Event[]) => void
  /** `closed` resolves once the stream's subscription is let go. */
  readonly ended: (reason: string, closed: Promise<void>) => void
}

/** One parcel subscription, shared by every watch with roots under its directory. */
type Stream = {
  readonly directory: string
  readonly listeners: Set<StreamListener>
  /** Attaches waiting for the stream to start. The stream is not closed while any wait. */
  claims: number
  /** Settles once the stream is live, with nothing, or with why it could not start. */
  ready: Promise<string | undefined>
  subscription?: ParcelWatcher.AsyncSubscription
  /** Subscriptions a renewal replaced, still delivering what happened before it. */
  readonly draining: Set<ParcelWatcher.AsyncSubscription>
  /** The renewal in flight, which a second caller joins. */
  renewing?: Promise<void>
  identity?: { readonly device: number; readonly inode: number }
  /** Why the stream ended. Nothing is delivered after it is set. */
  ended?: string
  /** Resolves once the ended stream's subscription is let go. */
  closed?: Promise<void>
  /** When a watch last attached to it, in attach order. */
  usedAt: number
}

const streams = new Map<string, Stream>()

/** `rootGone`: the directory itself was deleted or replaced, so parcel may be stopping the stream too. */
function endStream(stream: Stream, reason: string, rootGone = false) {
  if (stream.ended !== undefined) return
  stream.ended = reason
  const subscriptions = [stream.subscription, ...stream.draining]
  stream.draining.clear()
  stream.closed = Promise.all(subscriptions.map((subscription) => letGo(subscription, rootGone))).then(() => undefined)
  if (streams.get(stream.directory) === stream) streams.delete(stream.directory)
  const listeners = Array.from(stream.listeners)
  stream.listeners.clear()
  for (const listener of listeners) listener.ended(reason, stream.closed)
}

function deliver(stream: Stream, error: Error | null, events: readonly ParcelWatcher.Event[]) {
  if (stream.ended !== undefined) return
  if (error) {
    // The same delivery can carry the root's delete, which parcel is stopping the stream for.
    endStream(stream, error.message, true)
    return
  }
  // Deleted or moved away, the directory's stream is over; parcel has stopped it. Created, the
  // directory was moved back or made again, and whatever happened to it meanwhile went
  // unreported. Only its metadata changing leaves the stream whole.
  if (events.some((event) => event.type === "delete" && isRoot(event.path, stream.directory))) {
    endStream(stream, "its directory was deleted or moved away", true)
    return
  }
  // Parcel stops a stream only for a root it reports deleted, so this one is still running.
  if (events.some((event) => event.type !== "update" && isRoot(event.path, stream.directory))) {
    endStream(stream, "its directory was deleted, moved or made again")
    return
  }
  for (const listener of stream.listeners) listener.events(events)
  // A directory removed and made again inside one delivery can reach us as a create or update
  // of it, or not at all. The inode says whether this is still the directory the stream was
  // opened on.
  void lstat(stream.directory)
    .catch(() => undefined)
    .then((stats) => {
      if (stream.ended !== undefined || !stream.identity) return
      if (stats?.isDirectory() && stats.ino === stream.identity.inode && stats.dev === stream.identity.device) return
      endStream(stream, "its directory was replaced", true)
    })
}

/** A native watcher of its own for the stream: options no other subscription has. */
async function subscribe(stream: Stream, parcel: typeof import("@parcel/watcher"), chosen: ParcelWatcher.BackendType) {
  await ensureAnchor(parcel, chosen)
  return parcel.subscribe(stream.directory, (error, events) => deliver(stream, error, events), {
    backend: chosen,
    ignore: [`.agent-duel-unshared-${randomUUID()}`],
  })
}

function openStream(
  directory: string,
  parcel: typeof import("@parcel/watcher"),
  chosen: ParcelWatcher.BackendType,
): Stream {
  const stream: Stream = {
    directory,
    listeners: new Set(),
    claims: 0,
    ready: Promise.resolve(undefined),
    draining: new Set(),
    usedAt: ++streamUse,
  }
  streams.set(directory, stream)
  stream.ready = (async () => {
    const before = await lstat(directory).catch(() => undefined)
    if (!before?.isDirectory()) return "not a directory"
    const subscription = await subscribe(stream, parcel, chosen)
    stream.subscription = subscription
    if (stream.ended !== undefined) {
      // Whatever ended it may have been its root going, before the subscription was here to let go.
      void letGo(subscription, true)
      return stream.ended
    }
    // The stream is live from here. A directory replaced between the first look and now would
    // have a stream on a directory that is gone.
    const after = await lstat(directory).catch(() => undefined)
    if (stream.ended !== undefined) return stream.ended
    if (!after?.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) {
      return "its directory was replaced while the stream started"
    }
    stream.identity = { device: after.dev, inode: after.ino }
    return undefined
  })().catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))
  void stream.ready.then((failure) => {
    // Once subscribed, a failure can be the root going, which parcel stops the stream for.
    if (failure !== undefined) endStream(stream, failure, stream.subscription !== undefined)
  })
  return stream
}

/**
 * How long a replaced subscription keeps delivering. Parcel hands a write over 50-500 ms after
 * it happens (Debounce.hh), so by then it has delivered everything from before its replacement
 * started.
 */
const DRAIN_MS = 1_000

/**
 * Give the stream a new native watcher, which starts with no memory of reported paths. The old
 * one keeps delivering to the same listeners until it has drained, so the stream's coverage has
 * no gap. A write both of them report counts twice, which changes nothing.
 */
function renewStream(stream: Stream): Promise<void> {
  stream.renewing ??= (async () => {
    if ((await stream.ready) !== undefined || stream.ended !== undefined) return
    const parcel = watcher()
    const chosen = backend()
    if (!parcel || !chosen) return
    const fresh = await subscribe(stream, parcel, chosen).catch((cause: unknown) => {
      endStream(stream, `its stream could not be renewed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return undefined
    })
    if (!fresh) return
    if (stream.ended !== undefined) {
      // Whatever ended it may have been its root going, before the subscription was here to let go.
      void letGo(fresh, true)
      return
    }
    const previous = stream.subscription
    stream.subscription = fresh
    if (previous) {
      stream.draining.add(previous)
      setTimeout(() => {
        if (stream.draining.delete(previous)) void letGo(previous)
      }, DRAIN_MS)
    }
    // As when the stream opened: a directory replaced meanwhile would leave the new watcher on
    // a directory that is gone.
    const after = await lstat(stream.directory).catch(() => undefined)
    if (stream.ended !== undefined) return
    if (!after?.isDirectory() || after.ino !== stream.identity?.inode || after.dev !== stream.identity?.device) {
      endStream(stream, "its directory was replaced while the stream renewed", true)
    }
  })().finally(() => {
    stream.renewing = undefined
  })
  return stream.renewing
}

/** Attach to the stream on a directory, opening it first if nothing has. Resolves with why not. */
async function attach(directory: string, listener: StreamListener): Promise<string | undefined> {
  const parcel = watcher()
  const chosen = backend()
  if (!parcel || !chosen) return "no filesystem watcher backend on this platform"
  let stream = streams.get(directory)
  if (!stream) {
    if (streams.size >= STREAM_BUDGET && !stopOldestStream()) {
      return `the watches already hold ${STREAM_BUDGET} streams`
    }
    stream = openStream(directory, parcel, chosen)
  }
  stream.usedAt = ++streamUse
  stream.claims++
  let failure: string | undefined
  try {
    failure = await stream.ready
  } finally {
    stream.claims--
  }
  if (failure !== undefined) return failure
  if (stream.ended !== undefined) return stream.ended
  stream.listeners.add(listener)
  return undefined
}

/** Stop the stream attached longest ago that nothing is attaching to. Its watches read it as broken. */
function stopOldestStream() {
  let oldest: Stream | undefined
  for (const stream of streams.values()) {
    if (stream.claims > 0 || stream.ended !== undefined) continue
    if (!oldest || stream.usedAt < oldest.usedAt) oldest = stream
  }
  if (!oldest) return false
  endStream(oldest, `stopped to make room: the watches hold ${STREAM_BUDGET} streams`)
  return true
}

/** Resolves once the stream is let go, when this was its last listener. */
function detach(directory: string, listener: StreamListener): Promise<void> {
  const stream = streams.get(directory)
  if (!stream?.listeners.delete(listener)) return Promise.resolve()
  if (stream.listeners.size === 0 && stream.claims === 0) endStream(stream, "no longer watched")
  return stream.closed ?? Promise.resolve()
}

type WatchedRoot = {
  /** The directory whose stream covers the root, relative to the base. Empty for the base. */
  readonly group: string
  /** Where the root's coverage starts in the sequence. Unset while nothing covers it. */
  from?: number
  /** The sequence number of the latest change reported under the root. */
  changedAt?: number
  /**
   * Each path reported under the root since `wholeAt`, relative to the root and spelled as the
   * backend reported it, with the sequence number of its latest change.
   */
  written?: Map<string, number>
  /**
   * The latest change under the root that no kept path names: the root deleted or moved, an
   * ancestor moved, or a path dropped to keep the count down. A window that includes it reads
   * the root as written throughout, so the paths from before it are of no further use.
   */
  wholeAt?: number
  /** Why nothing covers the root, while nothing does. */
  unwatched?: string
  /** The root's own lstat identity when its coverage began, which an event on it is checked against. */
  identity?: RootIdentity
}

type RootIdentity = {
  readonly device: number
  readonly inode: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly mode: number
}

function rootIdentity(stats: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; mode: number }) {
  return { device: stats.dev, inode: stats.ino, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, mode: stats.mode }
}

/**
 * How long after a stream starts FSEvents may still replay what came before it. Measured at
 * 10-50 ms, with parcel's own delivery on top; a new native watcher started after this sees none
 * of it.
 */
const REPLAY_MS = 1_000

/**
 * The most paths kept per root, over the life of a chat's journal. A sync brings far fewer over
 * one by one before it clones the root whole instead. Past this the oldest are dropped, and a
 * window that reaches back to them reads the root as written throughout.
 */
const WRITTEN_PATHS_KEPT = 4_096

type Group = {
  readonly listener: StreamListener
  /** Settles once the group's stream is attached, with nothing, or with why not. */
  attached: Promise<string | undefined>
}

type RootWatches = {
  readonly base: string
  readonly foldedBase: string
  readonly epoch: string
  /** Which directory's stream covers a root. */
  readonly groupOf: (root: string) => string
  /**
   * Whether any event on a root itself reads it as written throughout. Otherwise, besides its
   * deletion, only one that finds the root's identity changed since its coverage began does.
   */
  readonly rootEvents: boolean
  /** Called when an event on a root itself was let through as a replay; parcel now remembers the root. */
  readonly replayed?: () => void
  /** Bumped by every coverage start, change and break, so an order between them is always known. */
  seq: number
  readonly roots: Map<string, WatchedRoot>
  /** Each root by its folded path, and each root's ancestors by theirs, to place a reported path. */
  readonly byPath: Map<string, string>
  readonly below: Map<string, Set<string>>
  readonly groups: Map<string, Group>
  /** Roots being brought under coverage right now. */
  readonly claims: Set<string>
  readonly pending: Set<Promise<void>>
  /** Streams that ended on their own and are still being let go. */
  readonly closing: Set<Promise<void>>
  stopped: boolean
  unavailable?: string
}

function createRootWatches(
  base: string,
  groupOf: (root: string) => string,
  rootEvents: boolean,
  replayed?: () => void,
): RootWatches {
  holdAnchor()
  return {
    base,
    rootEvents,
    ...(replayed ? { replayed } : {}),
    foldedBase: fold(base),
    epoch: randomUUID(),
    groupOf,
    seq: 0,
    roots: new Map(),
    byPath: new Map(),
    below: new Map(),
    groups: new Map(),
    claims: new Set(),
    pending: new Set(),
    closing: new Set(),
    stopped: false,
  }
}

/**
 * APFS matches names regardless of case and Unicode normalization, and a reported path can
 * spell a root either way. Matching folded everywhere can only attribute a write to a root
 * that did not need it.
 */
function fold(value: string) {
  return value.normalize("NFC").toLowerCase()
}

/** Whether a reported path is the watched root itself. */
function isRoot(reported: string, directory: string) {
  const candidate = reported.length > 1 && reported.endsWith(path.sep) ? reported.slice(0, -1) : reported
  if (candidate === directory) return true
  // APFS matches names regardless of case. A spelling that differs any further reads as a
  // change under the root, and a deletion of it is still caught by the identity check.
  return (
    process.platform === "darwin" &&
    candidate.length === directory.length &&
    candidate.toLowerCase() === directory.toLowerCase()
  )
}

/** A reported path relative to the base, folded; undefined when it is not under the base. */
function reportedPath(watches: RootWatches, reported: string) {
  const folded = fold(reported.length > 1 && reported.endsWith(path.sep) ? reported.slice(0, -1) : reported)
  if (folded === watches.foldedBase) return ""
  const prefix = `${watches.foldedBase}${path.sep}`
  return folded.startsWith(prefix) ? folded.slice(prefix.length).replaceAll(path.sep, "/") : undefined
}

/**
 * The part of a reported path below a root, spelled as the backend reported it, which is the
 * name the sync must create; undefined when the path cannot be split there exactly.
 */
function pathUnder(watches: RootWatches, reported: string, root: string) {
  const trimmed = reported.length > 1 && reported.endsWith(path.sep) ? reported.slice(0, -1) : reported
  const prefix = `${watches.base}${path.sep}${root.replaceAll("/", path.sep)}${path.sep}`
  const head = trimmed.slice(0, prefix.length)
  // Matched folded, like the root itself; a spelling whose length folding changes is not split.
  if (head.length !== prefix.length || fold(head) !== fold(prefix)) return undefined
  const under = trimmed.slice(prefix.length).replaceAll(path.sep, "/")
  const segments = under.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined
  return under
}

function register(watches: RootWatches, root: string) {
  const existing = watches.roots.get(root)
  if (existing) return existing
  const state: WatchedRoot = { group: watches.groupOf(root) }
  watches.roots.set(root, state)
  const folded = fold(root)
  watches.byPath.set(folded, root)
  for (let cut = folded.lastIndexOf("/"); cut > 0; cut = folded.lastIndexOf("/", cut - 1)) {
    const ancestor = folded.slice(0, cut)
    const roots = watches.below.get(ancestor) ?? new Set<string>()
    roots.add(root)
    watches.below.set(ancestor, roots)
  }
  return state
}

/**
 * Whether a root an event names itself is no longer as its coverage found it. Read at once, in
 * the delivery: the replay a stream starts with names a root that has not changed since, while
 * a root moved away and back, or its mode, owner or xattrs changed, has a new ctime.
 */
function rootChanged(watches: RootWatches, root: string) {
  const known = watches.roots.get(root)?.identity
  if (!known) return true
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(path.join(watches.base, root), { throwIfNoEntry: false })
  } catch {
    return true
  }
  if (!stats?.isDirectory()) return true
  const now = rootIdentity(stats)
  return (
    now.device !== known.device ||
    now.inode !== known.inode ||
    now.mtimeMs !== known.mtimeMs ||
    now.ctimeMs !== known.ctimeMs ||
    now.mode !== known.mode
  )
}

function observe(watches: RootWatches, group: string, events: readonly ParcelWatcher.Event[]) {
  if (watches.stopped) return
  const own = fold(group)
  const named = new Map<string, Set<string>>()
  const whole = new Set<string>()
  let replayed = false
  for (const event of events) {
    const reported = reportedPath(watches, event.path)
    // The stream's own directory: its deletion ends the stream, and nothing else about it is
    // a change to anything under it.
    if (reported === undefined || reported === own) continue
    // Under a root, or the root itself. Roots never nest, so the nearest match is the only one.
    let prefix: string | undefined = reported
    while (prefix) {
      const root = watches.byPath.get(prefix)
      if (root !== undefined) {
        if (prefix !== reported) {
          // The event's type is not kept: parcel's types accumulate flags over the last few
          // seconds, so the sync reads what stands at the path now on both sides instead.
          const under = pathUnder(watches, event.path, root)
          if (under === undefined) whole.add(root)
          else named.set(root, (named.get(root) ?? new Set()).add(under))
        } else if (event.type === "delete" || watches.rootEvents || rootChanged(watches, root)) whole.add(root)
        else replayed = true
        break
      }
      const cut: number = prefix.lastIndexOf("/")
      prefix = cut < 0 ? undefined : prefix.slice(0, cut)
    }
    // An ancestor of roots created, removed or moved: whatever happened below it under another
    // name was not reported under the roots' paths.
    for (const root of watches.below.get(reported) ?? []) whole.add(root)
  }
  if (replayed) watches.replayed?.()
  if (named.size === 0 && whole.size === 0) return
  const seq = ++watches.seq
  for (const [root, paths] of named) {
    const state = watches.roots.get(root)
    if (!state || whole.has(root)) continue
    state.changedAt = seq
    const written = (state.written ??= new Map())
    for (const under of paths) {
      // In order of latest change, so the oldest go first once there are too many.
      written.delete(under)
      written.set(under, seq)
    }
    for (const [under, at] of written) {
      if (written.size <= WRITTEN_PATHS_KEPT) break
      written.delete(under)
      state.wholeAt = Math.max(state.wholeAt ?? 0, at)
    }
  }
  for (const root of whole) {
    const state = watches.roots.get(root)
    if (!state) continue
    state.changedAt = seq
    state.wholeAt = seq
    state.written = undefined
  }
}

/** Attach the stream a group of roots is covered by, once per group. Resolves with why not. */
async function ensureGroup(watches: RootWatches, group: string): Promise<string | undefined> {
  let entry = watches.groups.get(group)
  if (!entry) {
    const directory = group === "" ? watches.base : path.join(watches.base, group)
    const created: Group = {
      listener: {
        events: (events) => observe(watches, group, events),
        ended: (reason, closed) => {
          watches.closing.add(closed)
          void closed.finally(() => watches.closing.delete(closed))
          if (watches.groups.get(group) !== created) return
          watches.groups.delete(group)
          watches.seq++
          for (const state of watches.roots.values()) {
            if (state.group !== group || state.from === undefined) continue
            state.from = undefined
            state.unwatched = `its watch stopped: ${reason}`
          }
        },
      },
      attached: Promise.resolve(undefined),
    }
    created.attached = attach(directory, created.listener).then((failure) => {
      if (failure !== undefined) {
        if (watches.groups.get(group) === created) watches.groups.delete(group)
        return failure
      }
      if (watches.stopped || watches.groups.get(group) !== created) {
        void detach(directory, created.listener)
        return "the watch stopped"
      }
      return undefined
    })
    watches.groups.set(group, created)
    entry = created
  }
  const failure = await entry.attached
  if (failure !== undefined) return failure
  return watches.groups.get(group) === entry ? undefined : "its watch stopped"
}

/** Bring one root under coverage. A root that is not a directory needs no watch and stays uncovered. */
async function watchRoot(watches: RootWatches, root: string) {
  if (watches.stopped || watches.claims.has(root) || watches.roots.get(root)?.from !== undefined) return
  if (!watcher() || !backend()) {
    watches.unavailable = "no filesystem watcher backend on this platform"
    return
  }
  const normal = path.posix.normalize(root)
  if (!root || normal !== root || normal === "." || normal.startsWith("../") || path.isAbsolute(root)) return
  watches.claims.add(root)
  try {
    const state = register(watches, root)
    const stats = await lstat(path.join(watches.base, root)).catch(() => undefined)
    if (!stats?.isDirectory()) {
      state.unwatched = "not a directory"
      return
    }
    const failure = await ensureGroup(watches, state.group)
    if (watches.stopped) return
    if (failure !== undefined) {
      state.unwatched = `its watch could not start: ${failure}`
      return
    }
    state.unwatched = undefined
    // Taken before the stream started, while nothing writes into the root: the sync is over and
    // no contestant runs yet.
    state.identity = rootIdentity(stats)
    state.from = ++watches.seq
  } finally {
    watches.claims.delete(root)
  }
}

async function watchRoots(watches: RootWatches, roots: readonly string[]) {
  // Still in use: the budget stops the streams nothing has used for longest.
  for (const group of watches.groups.keys()) {
    const stream = streams.get(group === "" ? watches.base : path.join(watches.base, group))
    if (stream) stream.usedAt = ++streamUse
  }
  await Promise.all(
    Array.from(new Set(roots)).map((root) => {
      const job = watchRoot(watches, root)
      watches.pending.add(job)
      return job.finally(() => watches.pending.delete(job))
    }),
  )
}

/** Give every stream the watches hold a new native watcher; see `renewStream`. */
async function renewRootWatches(watches: RootWatches) {
  await Promise.all(
    Array.from(watches.groups).flatMap(([group, entry]) => {
      const stream = streams.get(group === "" ? watches.base : path.join(watches.base, group))
      return stream?.listeners.has(entry.listener) ? [renewStream(stream)] : []
    }),
  )
}

async function stopRootWatches(watches: RootWatches) {
  if (watches.stopped) return
  watches.stopped = true
  // Awaited, so a caller that moves or deletes the directory next does it after the stream is
  // stopped rather than while parcel is also stopping it for the delete.
  const detached = Array.from(watches.groups, ([group, entry]) =>
    detach(group === "" ? watches.base : path.join(watches.base, group), entry.listener),
  )
  watches.groups.clear()
  await Promise.all([...detached, ...watches.closing])
  // A group still attaching sees `stopped` and lets go of its stream itself.
  await Promise.all(Array.from(watches.pending))
  await releaseAnchor()
}

/**
 * Which of `roots` changed or went uncovered after `since`, with why for the uncovered ones and,
 * for a written root, the paths written under it when the watch could name all of them.
 */
function observation(watches: RootWatches, roots: Iterable<string>, since: number | undefined): RootObservation {
  const changed = new Set<string>()
  const unwatched = new Map<string, string>()
  const paths = new Map<string, ReadonlySet<string>>()
  const after = since ?? 0
  for (const root of new Set(roots)) {
    const state = watches.roots.get(root)
    if (state?.from === undefined) {
      changed.add(root)
      unwatched.set(root, state?.unwatched ?? "not watched")
      continue
    }
    if (since !== undefined && state.from > since) {
      changed.add(root)
      unwatched.set(root, "first watched after the window began")
      continue
    }
    if (state.changedAt === undefined || state.changedAt <= after) continue
    changed.add(root)
    if ((state.wholeAt ?? 0) > after) continue
    const named = Array.from(state.written ?? [], ([under, at]) => (at > after ? under : undefined)).filter(
      (under): under is string => under !== undefined,
    )
    if (named.length > 0) paths.set(root, new Set(named))
  }
  return {
    complete: true,
    changed,
    ...(unwatched.size > 0 ? { unwatched } : {}),
    ...(paths.size > 0 ? { paths } : {}),
  }
}

/** Run one key's starts and stops in the order they were called. */
function serialized() {
  const tails = new Map<string, Promise<void>>()
  return (key: string, run: () => Promise<void>) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(run)
    const tail = next.catch(() => undefined)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}

/** A position in one journal's sequence of events. Meaningless to any other journal. */
export type JournalMark = { readonly epoch: string; readonly seq: number }

export type IgnoredJournal = {
  /** Start the journal for a chat, or retarget it when it already follows this checkout. */
  readonly begin: (key: string, canonical: string, roots: readonly string[]) => Promise<void>
  /** Watch roots the journal does not cover yet, including ones whose stream broke. */
  readonly retarget: (key: string, roots: readonly string[]) => Promise<void>
  /** Give every stream the journal holds a new native watcher. Call it right before a mark. */
  readonly renew: (key: string) => Promise<void>
  readonly mark: (key: string) => JournalMark | undefined
  /** Only directory roots are watched; any other root reads as changed. */
  readonly changedSince: (key: string, mark: JournalMark | undefined, roots: readonly string[]) => RootObservation
  readonly stop: (key: string) => Promise<void>
}

/** A checkout's roots share a stream per top-level directory; see the notes above. */
const topLevel = (root: string) => root.split("/", 1)[0]

/**
 * The checkout's ignored directory roots, followed for the life of a chat.
 *
 * Begin it, or retarget it with the roots about to be cloned, then renew it and take the mark,
 * all before the clone: every write the clone could have missed then shows up at the next
 * resync. The renewal is what lets a mode-only change to a file the journal reported earlier
 * show up too; see the notes above. When the manifest recorded the roots' identities does not
 * matter to this. A root first watched after a mark reads as changed for that mark. Each
 * journal record has a random epoch, so a mark from a journal that was stopped, or from before
 * a restart, never passes for this one.
 */
export function createIgnoredJournal(): IgnoredJournal {
  const records = new Map<string, RootWatches>()
  const queue = serialized()

  const stopRecord = async (key: string) => {
    const record = records.get(key)
    if (!record) return
    records.delete(key)
    await stopRootWatches(record)
  }

  const begin = (key: string, canonical: string, roots: readonly string[]) =>
    queue(key, async () => {
      // Resolved, because the backend reports resolved paths and a temp or symlinked
      // checkout resolves elsewhere. The manifest resolves its roots the same way.
      const base = await realpath(canonical).catch(() => path.resolve(canonical))
      const existing = records.get(key)
      if (existing?.base === base) {
        await watchRoots(existing, roots)
        return
      }
      await stopRecord(key)
      const record = createRootWatches(base, topLevel, true)
      records.set(key, record)
      await watchRoots(record, roots)
    })

  const retarget = (key: string, roots: readonly string[]) =>
    queue(key, async () => {
      const record = records.get(key)
      if (record) await watchRoots(record, roots)
    })

  const renew = (key: string) =>
    queue(key, async () => {
      const record = records.get(key)
      if (record) await renewRootWatches(record)
    })

  const mark = (key: string): JournalMark | undefined => {
    const record = records.get(key)
    return record ? { epoch: record.epoch, seq: record.seq } : undefined
  }

  /**
   * Which of `roots` were written, or went unwatched, after `mark`.
   *
   * Only what the backend has delivered counts, and parcel delivers 50-500 ms after the
   * write. A write that lands just before this call can still read as unchanged: callers
   * that must see it wait that long after the last moment that matters to them.
   */
  const changedSince = (key: string, since: JournalMark | undefined, roots: readonly string[]): RootObservation => {
    const record = records.get(key)
    if (!record) return { complete: false, changed: new Set(roots), reason: "no journal for this checkout" }
    if (since?.epoch !== record.epoch) {
      return { complete: false, changed: new Set(roots), reason: "the mark belongs to another journal" }
    }
    if (record.unavailable) return { complete: false, changed: new Set(roots), reason: record.unavailable }
    return observation(record, roots, since.seq)
  }

  return { begin, retarget, renew, mark, changedSince, stop: (key) => queue(key, () => stopRecord(key)) }
}

export type SlotWatch = {
  /** Only directory roots are watched; any other root reads as changed. */
  readonly begin: (directory: string, roots: readonly string[]) => Promise<void>
  /** `roots` adds roots to report on. Any the watch never covered reads as changed. */
  readonly settle: (directory: string, roots?: readonly string[]) => RootObservation
  readonly stop: (directory: string) => Promise<void>
}

/**
 * One kept worktree's copied directory roots, from the end of its sync to its next one.
 *
 * Begin it once the sync's own writes are over and stop it before the worktree is renamed:
 * a stream follows the path it was opened on, and a worktree moved away ends it. Any change
 * under a root after the watch began counts, whoever made it, and names the paths written so
 * the next sync can bring only those back to the checkout's state. Keyed by the resolved
 * directory path.
 */
export function createSlotWatch(): SlotWatch {
  type SlotRecord = {
    readonly watches: RootWatches
    readonly roots: readonly string[]
    /** The new native watcher due once a replay is over; see the notes above. */
    renewal?: ReturnType<typeof setTimeout>
  }
  const records = new Map<string, SlotRecord>()
  const queue = serialized()

  const stopRecord = async (key: string) => {
    const record = records.get(key)
    if (!record) return
    records.delete(key)
    clearTimeout(record.renewal)
    await stopRootWatches(record.watches)
  }

  const begin = (directory: string, roots: readonly string[]) => {
    const key = path.resolve(directory)
    return queue(key, async () => {
      await stopRecord(key)
      const base = await realpath(key).catch(() => key)
      const renewLater = () => {
        if (record.renewal !== undefined) return
        record.renewal = setTimeout(() => {
          record.renewal = undefined
          void queue(key, async () => {
            if (records.get(key) === record) await renewRootWatches(record.watches)
          })
        }, REPLAY_MS)
        record.renewal.unref()
      }
      const record: SlotRecord = {
        watches: createRootWatches(base, () => "", false, renewLater),
        roots: Array.from(new Set(roots)),
      }
      records.set(key, record)
      await watchRoots(record.watches, roots)
    })
  }

  /**
   * Which roots were written, or went unwatched, since the watch began.
   *
   * Only what the backend has delivered counts, and parcel delivers 50-500 ms after the
   * write. Settle no sooner than that after the last process that could write into the
   * worktree was stopped.
   */
  const settle = (directory: string, extra: readonly string[] = []): RootObservation => {
    const record = records.get(path.resolve(directory))
    const roots = Array.from(new Set([...(record?.roots ?? []), ...extra]))
    if (!record) return { complete: false, changed: new Set(roots), reason: "this worktree is not being watched" }
    if (record.watches.unavailable) {
      return { complete: false, changed: new Set(roots), reason: record.watches.unavailable }
    }
    return observation(record.watches, roots, undefined)
  }

  return {
    begin,
    settle,
    stop: (directory) => {
      const key = path.resolve(directory)
      return queue(key, () => stopRecord(key))
    },
  }
}

/** For a canonical state nothing can edit underneath the engine. */
export const alwaysObserved: EnvironmentWatch = {
  begin: async () => undefined,
  retarget: async () => undefined,
  settle: () => ({ changed: new Set(), complete: true }),
  stop: async () => undefined,
}

/** For a deployment with no watcher: every send re-clones. */
export const neverObserved: EnvironmentWatch = {
  begin: async () => undefined,
  retarget: async () => undefined,
  settle: () => unobserved("environment watching is disabled"),
  stop: async () => undefined,
}

export const ArenaEnvironmentWatch = {
  createEnvironmentWatch,
  createIgnoredJournal,
  createSlotWatch,
  alwaysObserved,
  neverObserved,
  NO_RECORD,
}
