import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { cloneTree } from "../util/copy-tree"

export type CopyGitStateInput = {
  /** Canonical common git directory, absolute. */
  readonly source: string
  /** Host directory to create. Must not exist. */
  readonly target: string
  /**
   * Ref name prefixes, each ending in `/`, left out of the copy along with their reflogs.
   * Only a files-backend repository is filtered; reftable refs are left to the caller.
   */
  readonly excludeRefPrefixes?: readonly string[]
  /** Override the clone for filesystems without copy-on-write support in tests. */
  readonly clone?: typeof cloneTree
}

/**
 * True for a top-level git directory entry that must not reach a host copy: the
 * linked-worktree registrations, which would register the developer's worktrees inside the
 * contestant; the per-worktree half of the config, which belongs to the developer's checkout
 * and not to a copy of it; the file-system monitor's directory, which holds a live Unix socket
 * that cannot be copied at all; and lock files, which mark a write in flight in the source and
 * would block every ref update in the host. Everything else is copied, including the index and
 * the files of an operation in progress; a bare repository does not read them.
 *
 * `config.worktree` matters three times, because git reads it whenever `extensions.worktreeConfig`
 * is set and it wins over `config`. The source's copy is dropped: `git config --worktree core.bare
 * false` there would survive the bare-ification below and make `git worktree add` fail with
 * `'main' is already used by worktree at <host>`; `git sparse-checkout set` turns the extension on
 * by itself, and the `core.sparseCheckout` it leaves would give the contestant a partial tree
 * without saying so. The host then writes its own, because with the extension on a `core.bare` in
 * the shared `config` reaches the linked worktrees too and makes the contestant bare, so
 * `git reset --hard` in it dies with `this operation must be run in a work tree`. `core.bare`
 * belongs in the bare host's own `config.worktree`, which no linked worktree reads.
 */
export function isExcludedGitEntry(name: string) {
  return name === "worktrees" || name === "config.worktree" || name === "fsmonitor--daemon" || name.endsWith(".lock")
}

/**
 * Copy a git directory into a new bare repository.
 *
 * The copy is what makes a contestant behave like the developer's checkout: the same
 * hooks, config, remotes, objects, and refs. The copy lands in `<target>.partial` and is
 * renamed at the end, so a `HEAD` at the target means the copy is complete.
 *
 * The whole directory is cloned copy-on-write first: outside `objects` a checkout's git
 * directory still holds hundreds of refs and logs, and copying them file by file cost
 * 0.6-1.1 s a side on a 320 MB Next.js checkout against 0.2 s for the clone. Where that clone
 * is not a faithful copy, only `objects` is cloned and the rest copied through the filter.
 */
export async function copyGitState(input: CopyGitStateInput) {
  const partial = `${input.target}.partial`
  const clone = input.clone ?? cloneTree
  await rm(partial, { recursive: true, force: true })
  const { mode } = await stat(input.source)
  if (!(await cloneGitDirectory(input.source, partial, clone))) {
    // cloneTree creates its parent first; preserve the mode cp would give a new git directory.
    await mkdir(partial, { recursive: true, mode })
    const clonedObjects = await cloneObjects(input.source, partial, clone)
    await cp(input.source, partial, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(input.source, entry)
        if (!relative) return true
        const segments = relative.split(path.sep)
        if (clonedObjects && segments[0] === "objects") return false
        if (segments.length === 1) return !isExcludedGitEntry(segments[0]!)
        // Below the top level only lock files are skipped: a directory named `worktrees` deep
        // in `refs/heads/` is a branch, not the registration directory.
        return !path.basename(entry).endsWith(".lock")
      },
    })
  }
  await chmod(partial, mode)
  await absoluteAlternates(path.join(input.source, "objects"), path.join(partial, "objects", "info", "alternates"))
  if (await gitConfigBool(partial, "extensions.worktreeConfig")) {
    // Exit 5: the key was not set. Anything else is a real failure.
    await gitConfig(partial, ["--unset", "core.bare"], [0, 5])
    await gitConfig(partial, ["--worktree", "core.bare", "true"])
  } else {
    await gitConfig(partial, ["core.bare", "true"])
  }
  await gitConfig(partial, ["--unset", "core.worktree"], [0, 5])
  if (input.excludeRefPrefixes?.length) await dropRefs(partial, input.excludeRefPrefixes)
  await rename(partial, input.target)
}

/**
 * Delete every ref under `prefixes` from a copied git directory: the loose refs, their lines
 * in `packed-refs` with the peeled line that follows each, and their reflogs.
 *
 * Edited as files, so no git process has to list a few thousand battle refs first; nothing
 * reads the copy before the rename after this, so nothing sees it half filtered. A reftable
 * repository keeps refs in binary tables only git may edit, so it is left alone and the
 * caller removes those refs through git.
 */
async function dropRefs(gitDir: string, prefixes: readonly string[]) {
  const storage = await gitConfigValue(gitDir, "extensions.refStorage")
  if (storage !== undefined && storage !== "files") return
  for (const prefix of prefixes) {
    const relative = prefix.replace(/\/+$/, "")
    for (const root of [gitDir, path.join(gitDir, "logs")]) {
      const target = path.join(root, relative)
      // A file at the prefix is a ref named like the namespace, `refs/heads/agent-duel` itself,
      // which is not under it.
      if ((await lstat(target).catch(() => undefined))?.isDirectory()) {
        await rm(target, { recursive: true, force: true })
      }
    }
  }
  const packed = path.join(gitDir, "packed-refs")
  const text = await readFile(packed, "utf8").catch(() => undefined)
  if (text === undefined) return
  const kept: string[] = []
  let dropping = false
  for (const line of text.split("\n")) {
    // `^<id>` is the peeled value of the ref on the line above and goes with it.
    if (line.startsWith("^")) {
      if (!dropping) kept.push(line)
      continue
    }
    const name = line.startsWith("#") ? "" : line.slice(line.indexOf(" ") + 1)
    dropping = prefixes.some((prefix) => name.startsWith(prefix))
    if (!dropping) kept.push(line)
  }
  const filtered = kept.join("\n")
  if (filtered !== text) await writeFile(packed, filtered)
}

/**
 * Clone the whole git directory and bring it to what the filtered copy would produce. The
 * excluded top-level entries and lock files outside `objects` are removed, as the filter skips
 * them. A symlink or special file anywhere, or a lock under `objects`, means the clone is not
 * that copy: it is discarded and `false` returned, and the caller takes the per-part path.
 */
async function cloneGitDirectory(source: string, target: string, clone: typeof cloneTree) {
  const method = await clone(source, target).catch(() => undefined)
  if (method && (await lstat(target).catch(() => undefined))?.isDirectory()) {
    for (const name of await readdir(target)) {
      if (isExcludedGitEntry(name)) await rm(path.join(target, name), { recursive: true, force: true })
    }
    const entries = await readdir(target, { recursive: true, withFileTypes: true })
    const locks: string[] = []
    const faithful = entries.every((entry) => {
      if (!entry.isFile() && !entry.isDirectory()) return false
      if (!entry.name.endsWith(".lock")) return true
      const full = path.join(entry.parentPath, entry.name)
      locks.push(full)
      return path.relative(target, full).split(path.sep)[0] !== "objects"
    })
    if (faithful) {
      for (const lock of locks) await rm(lock, { recursive: true, force: true })
      return true
    }
  }
  await rm(target, { recursive: true, force: true })
  return false
}

async function cloneObjects(source: string, target: string, clone: typeof cloneTree) {
  const objects = path.join(target, "objects")
  const method = await clone(path.join(source, "objects"), objects)
  if (method && (await lstat(objects)).isDirectory()) {
    // Validate the completed clone, not the changing source. The filtered copy excludes
    // locks and resolves symlinks; a raw clone must not bypass either behavior.
    const entries = await readdir(objects, { recursive: true, withFileTypes: true })
    if (entries.every((entry) => !entry.name.endsWith(".lock") && (entry.isFile() || entry.isDirectory()))) {
      return true
    }
  }
  await rm(objects, { recursive: true, force: true })
  return false
}

/** A relative alternates line is relative to the source objects directory, not the copy's. */
async function absoluteAlternates(sourceObjects: string, file: string) {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return
  const lines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || path.isAbsolute(trimmed)) return line
    return path.resolve(sourceObjects, trimmed)
  })
  await writeFile(file, lines.join("\n"))
}

/** Exit 1 means the key is unset, which reads as undefined. */
async function gitConfigValue(gitDir: string, key: string) {
  const child = Bun.spawn(["git", "--git-dir", gitDir, "config", "--get", key], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(child.stdout).text()
  const code = await child.exited
  if (code === 1) return undefined
  if (code !== 0) throw new Error(`git config --get ${key} failed with exit ${code}`)
  return text.trim().toLowerCase()
}

/** Exit 1 means the key is unset, which reads as false. */
async function gitConfigBool(gitDir: string, key: string) {
  const child = Bun.spawn(["git", "--git-dir", gitDir, "config", "--type=bool", "--get", key], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(child.stdout).text()
  const code = await child.exited
  if (code === 1) return false
  if (code !== 0) throw new Error(`git config --get ${key} failed with exit ${code}`)
  return text.trim() === "true"
}

async function gitConfig(gitDir: string, args: readonly string[], allowed: readonly number[] = [0]) {
  const child = Bun.spawn(["git", "--git-dir", gitDir, "config", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const code = await child.exited
  if (allowed.includes(code)) return
  const detail = (await new Response(child.stderr).text()).trim()
  throw new Error(`git config ${args.join(" ")} failed with exit ${code}${detail ? `: ${detail}` : ""}`)
}
