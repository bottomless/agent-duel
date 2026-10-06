import { cp, lstat, mkdir, rename, rm, stat } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

export type CopyMethod = "clonefile" | "reflink" | "copy"

/** A copy that shares blocks with its source. `copy` is the plain fallback, not a clone. */
export type CloneMethod = Exclude<CopyMethod, "copy">

/**
 * Clone a file or a directory tree copy-on-write, or report that this filesystem cannot.
 *
 * The trees this moves are dependency directories: hundreds of megabytes across tens of
 * thousands of small files. Cloning shares blocks with the source, so the copy costs disk
 * only where the two later diverge — but on a tree this shape, *time* is dominated by the
 * per-file syscall count, not by bytes. macOS `clonefile(2)` clones a whole directory in
 * one call and is roughly ten times faster than walking the tree with `cp -Rc`
 * (3s against 29s on a 90k-file `node_modules`), so it is worth reaching for directly.
 *
 * Every strategy fails outright when the filesystem cannot clone rather than falling back,
 * and a failure can leave a partial tree behind, which is removed before the next attempt.
 * `undefined` means no strategy worked and the caller has to decide whether a plain copy
 * is worth its cost.
 */
export type CloneOptions = {
  /**
   * Where a directory is built before it moves to `target` in one rename. It must be on the
   * target's volume and outside anything watched: a tree cloned child by child reports every
   * child as created, and a watch begun just after would count that as a write. Moved in whole,
   * the tree reports only its root, as a single `clonefile(2)` does.
   */
  readonly staging?: string
  /**
   * Stops a clone between two `clonefile(2)` calls, removes what it built, and rejects with the
   * signal's reason. A stopped battle need not wait for the rest of its dependency copy.
   */
  readonly signal?: AbortSignal
}

export async function cloneTree(
  source: string,
  target: string,
  options: CloneOptions = {},
): Promise<CloneMethod | undefined> {
  options.signal?.throwIfAborted()
  await mkdir(path.dirname(target), { recursive: true })
  const directory = await lstat(source).then(
    (stats) => stats.isDirectory(),
    () => false,
  )
  if (options.staging && directory) {
    const staged = path.join(options.staging, `${path.basename(target)}-${randomUUID()}`)
    await mkdir(options.staging, { recursive: true })
    const method = await cloneWithStrategies(source, staged, options.signal).catch((reason: unknown) => {
      // A stopped clone can leave most of a dependency tree behind. Nothing else uses its unique
      // staging name, so it is removed in the background rather than holding up the stop.
      void rm(staged, { recursive: true, force: true }).catch(() => undefined)
      throw reason
    })
    // A rename across volumes fails, and the clone then goes straight to the target.
    const moved =
      method !== undefined &&
      (await rename(staged, target).then(
        () => true,
        () => false,
      ))
    if (moved) return method
    await rm(staged, { recursive: true, force: true })
  }
  return await cloneWithStrategies(source, target, options.signal).catch(async (reason: unknown) => {
    await rm(target, { recursive: true, force: true })
    throw reason
  })
}

/** Rejects, leaving the partial tree for the caller to remove, when the signal stops the clone. */
async function cloneWithStrategies(source: string, target: string, signal?: AbortSignal) {
  for (const strategy of cloneStrategies()) {
    const cloned = await strategy.attempt(source, target, signal)
    signal?.throwIfAborted()
    if (cloned) return strategy.method
    await rm(target, { recursive: true, force: true })
  }
  return undefined
}

let darwinClonefile: ((source: string, target: string) => boolean) | null | undefined

/**
 * Clone one regular file copy-on-write, keeping its mode, times and extended attributes as a
 * tree clone does. `cloneTree` runs each clone in a worker of its own, one at a time, which
 * costs a few milliseconds per call; a file's `clonefile(2)` returns in microseconds, so it runs
 * here. Anything but macOS goes through `cloneTree`.
 */
export async function cloneFile(source: string, target: string): Promise<CloneMethod | undefined> {
  if (process.platform !== "darwin") return await cloneTree(source, target)
  if (darwinClonefile === undefined) {
    darwinClonefile = null
    try {
      const { dlopen, FFIType, suffix } = await import("bun:ffi")
      const lib = dlopen(`libSystem.B.${suffix}`, {
        clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      })
      darwinClonefile = (from, to) =>
        lib.symbols.clonefile(Buffer.from(`${from}\0`), Buffer.from(`${to}\0`), CLONE_NOFOLLOW) === 0
    } catch {
      darwinClonefile = null
    }
  }
  if (!darwinClonefile) return await cloneTree(source, target)
  await mkdir(path.dirname(target), { recursive: true })
  return darwinClonefile(source, target) ? "clonefile" : undefined
}

const CLONE_NOFOLLOW = 0x0001

/**
 * Copy a directory tree, preferring a copy-on-write clone.
 *
 * An existing target is left alone. Callers copy into a freshly checked out worktree, so
 * anything already at the target came from the base tree and must not be replaced.
 */
export async function copyTree(source: string, target: string): Promise<"cloned" | "copied" | "skipped"> {
  if (await exists(target)) return "skipped"
  if (await cloneTree(source, target)) return "cloned"
  await cp(source, target, { recursive: true })
  return "copied"
}

type CloneStrategy = {
  readonly method: CloneMethod
  readonly attempt: (source: string, target: string, signal?: AbortSignal) => Promise<boolean>
}

// Concurrent whole-tree clones contend badly on dependency trees. Keep the engine responsive,
// but admit only one clonefile subprocess at a time across Arena sessions.
let darwinClonefileTail = Promise.resolve()

function cloneStrategies(): readonly CloneStrategy[] {
  if (process.platform === "darwin") {
    const syscall = workerDarwinClonefile()
    const spawned = { method: "clonefile", attempt: spawnClone(["cp", "-Rc"]) } as const
    return [{ method: "clonefile", attempt: syscall }, spawned]
  }
  if (process.platform === "linux") {
    return [{ method: "reflink", attempt: spawnClone(["cp", "-a", "--reflink=always"]) }]
  }
  return []
}

function spawnClone(command: readonly string[]) {
  return async (source: string, target: string, signal?: AbortSignal) => {
    const process = Bun.spawn([...command, source, target], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ...(signal ? { signal } : {}),
    })
    return (await process.exited) === 0
  }
}

const CLONEFILE_WORKER = String.raw`
  import { dlopen, FFIType, suffix } from "bun:ffi";
  import { chmodSync, lstatSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
  import { basename, join } from "node:path";
  const lib = dlopen("libSystem.B." + suffix, {
    clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  });
  const clone = (source, target) =>
    lib.symbols.clonefile(Buffer.from(source + "\0"), Buffer.from(target + "\0"), 0x0001) === 0;
  let stop;
  const split = (source, target, depth) => {
    if (Atomics.load(stop, 0) !== 0) return false;
    const stats = lstatSync(source);
    if (!stats.isDirectory()) return clone(source, target);
    if (depth > 0 && !basename(source).startsWith("@")) return clone(source, target);
    mkdirSync(target);
    for (const entry of readdirSync(source)) {
      if (!split(join(source, entry), join(target, entry), depth + 1)) return false;
    }
    chmodSync(target, stats.mode & 0o7777);
    utimesSync(target, stats.atime, stats.mtime);
    return true;
  };
  self.onmessage = (event) => {
    const { source, target } = event.data;
    stop = event.data.stop;
    let cloned = false;
    try {
      cloned = split(source, target, 0);
    } catch {}
    self.postMessage(cloned);
  };
`

/**
 * One worker for every clone. Starting a worker costs a few milliseconds, more than cloning a
 * small tree, and a resync can clone a few hundred small trees in a row. The clones are one at a
 * time anyway, so one worker serves them all. Unreferenced so it never keeps the process alive,
 * and replaced after any error.
 */
let clonefileWorker: { readonly worker: Worker; readonly url: string } | undefined

function dropClonefileWorker() {
  const current = clonefileWorker
  clonefileWorker = undefined
  if (!current) return
  current.worker.terminate()
  URL.revokeObjectURL(current.url)
}

/**
 * Run `clonefile(2)` in a Bun worker. The syscall is fast but synchronous, and dependency trees
 * can still keep it inside the kernel for several seconds. Calling it through FFI on the main
 * thread freezes every Arena session and its HTTP server.
 *
 * A directory is cloned one child at a time rather than in one call: a whole-tree clone blocks
 * every `rename(2)` on the volume until it returns, 0.9-1.3 s for one `node_modules`, in
 * directories unrelated to the clone. Git saves its config, index and refs through lockfile
 * renames, so a contestant's snapshots and `git` commands would stall behind each whole-tree
 * clone while its environment copies. One clone per child keeps every call short at the same
 * total cost. Scoped package directories (`@scope/`) group many packages, so they split one level
 * further. A directory made rather than cloned gets its mode and times restored by hand.
 */
function workerDarwinClonefile(): CloneStrategy["attempt"] {
  return async (source, target, signal) => {
    const previous = darwinClonefileTail
    let release = () => {}
    darwinClonefileTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    // Shared with the worker, which checks it before each child it clones.
    const stop = new Int32Array(new SharedArrayBuffer(4))
    const abort = () => Atomics.store(stop, 0, 1)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      if (!clonefileWorker) {
        const url = URL.createObjectURL(new Blob([CLONEFILE_WORKER], { type: "text/javascript" }))
        // Bun's worker has Node's `unref`; the DOM type it is declared with does not.
        const worker: Worker & { unref?: () => void } = new Worker(url)
        worker.unref?.()
        clonefileWorker = { worker, url }
      }
      const { worker } = clonefileWorker
      return await new Promise<boolean>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data === true)
        worker.onerror = reject
        worker.postMessage({ source, target, stop })
      })
    } catch {
      dropClonefileWorker()
      return false
    } finally {
      signal?.removeEventListener("abort", abort)
      release()
    }
  }
}

async function exists(target: string) {
  return await stat(target).then(
    () => true,
    () => false,
  )
}
