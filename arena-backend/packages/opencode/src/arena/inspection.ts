import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path"
import { Effect } from "effect"
import { Git } from "@/git"

export const limits = {
  maxTreeEntries: 5_000,
  maxTreeOutputBytes: 2 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxPathBytes: 4 * 1024,
} as const

const treeResponseReserve = 32 * 1024

export type Limits = {
  readonly maxTreeEntries: number
  readonly maxTreeOutputBytes: number
  readonly maxFileBytes: number
  readonly maxPathBytes: number
}

export type TreeEntry = {
  readonly path: string
  readonly type: "file" | "directory" | "symlink" | "submodule" | "other"
  readonly size?: number
  readonly mode?: string
  readonly objectID?: string
}

export type Tree = {
  readonly source: "live" | "finalized"
  readonly revision?: { readonly commit: string; readonly ref?: string }
  readonly entries: readonly TreeEntry[]
  readonly entryCount: number
  readonly outputBytes: number
  readonly truncated: boolean
  readonly limits: {
    readonly maxEntries: number
    readonly maxOutputBytes: number
  }
}

export type File = {
  readonly source: "live" | "finalized"
  readonly revision?: { readonly commit: string; readonly ref?: string }
  readonly path: string
  readonly type: "file" | "symlink"
  readonly size: number
  readonly returnedBytes: number
  readonly truncated: boolean
  readonly binary: boolean
  readonly encoding: "utf8" | "base64"
  readonly content: string
  readonly hash: {
    readonly algorithm: "sha256"
    readonly value: string
    readonly scope: "full_content" | "returned_prefix"
  }
  readonly mode?: string
  readonly objectID?: string
  readonly limitBytes: number
}

type FinalizedInput = {
  readonly repository: string
  readonly commit: string
  readonly tree: string
  readonly ref: string
  readonly limits?: Partial<Limits>
}

function boundedLimits(input?: Partial<Limits>): Limits {
  const value = { ...limits, ...input }
  if (
    !Number.isSafeInteger(value.maxTreeEntries) ||
    value.maxTreeEntries < 1 ||
    value.maxTreeEntries > limits.maxTreeEntries ||
    !Number.isSafeInteger(value.maxTreeOutputBytes) ||
    value.maxTreeOutputBytes < 1 ||
    value.maxTreeOutputBytes > limits.maxTreeOutputBytes ||
    !Number.isSafeInteger(value.maxFileBytes) ||
    value.maxFileBytes < 1 ||
    value.maxFileBytes > limits.maxFileBytes ||
    !Number.isSafeInteger(value.maxPathBytes) ||
    value.maxPathBytes < 1 ||
    value.maxPathBytes > limits.maxPathBytes
  ) {
    throw new Error("Arena inspection limits must be positive safe integers within the fixed caps")
  }
  return value
}

export function repositoryPath(value: string, input?: Partial<Limits>) {
  const configured = boundedLimits(input)
  if (!value || Buffer.byteLength(value) > configured.maxPathBytes) {
    throw new Error("Arena inspection path is empty or too long")
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Arena inspection path contains a control character")
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\") || value.includes(":")) {
    throw new Error("Arena inspection path must be repository-relative POSIX syntax")
  }
  const segments = value.split("/")
  if (segments.length > 128) throw new Error("Arena inspection path has too many segments")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Arena inspection path must be canonical and cannot traverse outside the repository")
  }
  if (segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))) {
    throw new Error("Arena inspection path is not portable")
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error("Arena inspection cannot access Git metadata")
  }
  return segments.join("/")
}

function inside(root: string, candidate: string) {
  const value = relative(root, candidate)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function liveError(error: unknown, path?: string): never {
  if (missing(error) && path) throw new Error(`Arena inspection path not found: ${path}`)
  throw new Error("Arena live inspection is unavailable")
}

async function liveRoot(root: string) {
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid root")
    return { path: root, real: await realpath(root) }
  } catch (error) {
    return liveError(error)
  }
}

async function liveNode(root: string, path: string) {
  try {
    const base = await liveRoot(root)
    const segments = path.split("/")
    const target = join(base.path, ...segments)
    const parent = await realpath(dirname(target))
    if (!inside(base.real, parent)) throw new Error("outside root")

    let current = base.path
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      const info = await lstat(current)
      if (index < segments.length - 1 && (!info.isDirectory() || info.isSymbolicLink())) {
        throw new Error("symlink traversal")
      }
    }
    return { target, info: await lstat(target) }
  } catch (error) {
    return liveError(error, path)
  }
}

function treeEntryBytes(entry: TreeEntry) {
  return Buffer.byteLength(JSON.stringify(entry))
}

function appendEntry(entries: TreeEntry[], entry: TreeEntry, outputBytes: number, configured: Limits) {
  const bytes = treeEntryBytes(entry)
  const entryBudget = Math.max(0, configured.maxTreeOutputBytes - treeResponseReserve)
  if (entries.length >= configured.maxTreeEntries || outputBytes + bytes > entryBudget) {
    return { outputBytes, appended: false as const }
  }
  entries.push(entry)
  return { outputBytes: outputBytes + bytes, appended: true as const }
}

export async function liveTree(root: string, input?: Partial<Limits>): Promise<Tree> {
  const configured = boundedLimits(input)
  const base = await liveRoot(root)
  const entries: TreeEntry[] = []
  const pending: ReadonlyArray<string>[] = [[]]
  let outputBytes = 0
  let truncated = false

  while (pending.length) {
    if (entries.length >= configured.maxTreeEntries) {
      truncated = true
      break
    }
    const segments = pending.shift()!
    const directory = join(base.path, ...segments)
    let before
    const items = []
    try {
      before = await lstat(directory)
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe directory")
      const resolved = await realpath(directory)
      if (!inside(base.real, resolved)) throw new Error("outside root")
      const handle = await opendir(directory)
      for await (const item of handle) {
        if (item.name.toLowerCase() === ".git") continue
        if (items.length >= configured.maxTreeEntries - entries.length + 1) {
          truncated = true
          break
        }
        items.push(item)
      }
      const after = await lstat(directory)
      if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) {
        throw new Error("directory changed during inspection")
      }
    } catch (error) {
      return liveError(error)
    }

    items.sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      const child = [...segments, item.name]
      const path = child.join("/")
      let info
      try {
        info = await lstat(join(base.path, ...child))
      } catch (error) {
        if (missing(error)) continue
        return liveError(error)
      }
      const type = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other"
      const appended = appendEntry(
        entries,
        {
          path,
          type,
          ...(type === "file" || type === "symlink" ? { size: info.size } : {}),
        },
        outputBytes,
        configured,
      )
      outputBytes = appended.outputBytes
      if (!appended.appended) {
        truncated = true
        break
      }
      if (type === "directory") pending.push(child)
    }
    if (truncated) break
  }

  return {
    source: "live",
    entries,
    entryCount: entries.length,
    outputBytes,
    truncated,
    limits: { maxEntries: configured.maxTreeEntries, maxOutputBytes: configured.maxTreeOutputBytes },
  }
}

function content(bytes: Uint8Array, truncated: boolean) {
  const binary = bytes.includes(0)
  if (!binary) {
    try {
      return {
        binary: false,
        encoding: "utf8" as const,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        hash: {
          algorithm: "sha256" as const,
          value: createHash("sha256").update(bytes).digest("hex"),
          scope: truncated ? ("returned_prefix" as const) : ("full_content" as const),
        },
      }
    } catch {}
  }
  return {
    binary: true,
    encoding: "base64" as const,
    content: Buffer.from(bytes).toString("base64"),
    hash: {
      algorithm: "sha256" as const,
      value: createHash("sha256").update(bytes).digest("hex"),
      scope: truncated ? ("returned_prefix" as const) : ("full_content" as const),
    },
  }
}

async function readLivePrefix(path: string, expected: Awaited<ReturnType<typeof lstat>>, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await handle.stat()
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isFile()) {
      throw new Error("file changed during inspection")
    }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(actual.size, 1)))
    let offset = 0
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const observed = await handle.stat()
    if (observed.dev !== actual.dev || observed.ino !== actual.ino || !observed.isFile()) {
      throw new Error("file changed during inspection")
    }
    const bytes = buffer.subarray(0, Math.min(offset, maxBytes))
    return { bytes, size: observed.size, truncated: observed.size > maxBytes || offset > maxBytes }
  } finally {
    await handle.close()
  }
}

export async function liveFile(root: string, value: string, input?: Partial<Limits>): Promise<File> {
  const configured = boundedLimits(input)
  const path = repositoryPath(value, configured)
  const node = await liveNode(root, path)
  if (node.info.isDirectory()) throw new Error(`Arena inspection path is a directory: ${path}`)
  if (node.info.isSymbolicLink()) {
    let target
    try {
      target = await readlink(node.target, { encoding: "buffer" })
    } catch (error) {
      return liveError(error, path)
    }
    const truncated = target.length > configured.maxFileBytes
    const bytes = target.subarray(0, configured.maxFileBytes)
    return {
      source: "live",
      path,
      type: "symlink",
      size: target.length,
      returnedBytes: bytes.length,
      truncated,
      ...content(bytes, truncated),
      limitBytes: configured.maxFileBytes,
    }
  }
  if (!node.info.isFile()) throw new Error(`Arena inspection path is not a regular file: ${path}`)

  try {
    const value = await readLivePrefix(node.target, node.info, configured.maxFileBytes)
    return {
      source: "live",
      path,
      type: "file",
      size: value.size,
      returnedBytes: value.bytes.length,
      truncated: value.truncated,
      ...content(value.bytes, value.truncated),
      limitBytes: configured.maxFileBytes,
    }
  } catch (error) {
    return liveError(error, path)
  }
}

function gitError(operation: string) {
  return new Error(`Arena finalized ${operation} is unavailable`)
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true })

function parseTreeRecord(record: Uint8Array): TreeEntry | undefined {
  const tab = record.indexOf(9)
  if (tab < 0) return undefined
  const [mode, type, objectID, size] = Buffer.from(record.subarray(0, tab)).toString("ascii").trim().split(/\s+/)
  const path = (() => {
    try {
      return strictDecoder.decode(record.subarray(tab + 1))
    } catch {
      return undefined
    }
  })()
  if (!mode || !type || !objectID || !path) return undefined
  return {
    path,
    type: mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : type === "tree" ? "directory" : "file",
    ...(size && size !== "-" ? { size: Number.parseInt(size, 10) } : {}),
    mode,
    objectID,
  }
}

function records(value: Uint8Array) {
  const output: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== 0) continue
    output.push(value.subarray(start, index))
    start = index + 1
  }
  return { output, complete: start === value.length }
}

function revision(input: FinalizedInput) {
  const objectID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
  if (!objectID.test(input.commit) || !objectID.test(input.tree)) {
    throw gitError("revision")
  }
  return { commit: input.commit, ref: input.ref }
}

const verifyFinalized = Effect.fn("ArenaInspection.verifyFinalized")(function* (
  git: Git.Interface,
  input: FinalizedInput,
) {
  const inspectedRevision = yield* Effect.try({
    try: () => revision(input),
    catch: (error) => (error instanceof Error ? error : gitError("revision")),
  })
  const env = { GIT_NO_REPLACE_OBJECTS: "1" }
  const [format, ref, tree] = yield* Effect.all([
    git.run(["check-ref-format", input.ref], {
      cwd: input.repository,
      env,
      maxOutputBytes: 1024,
    }),
    git.run(["rev-parse", "--verify", "--end-of-options", `${input.ref}^{commit}`], {
      cwd: input.repository,
      env,
      maxOutputBytes: 1024,
    }),
    git.run(["rev-parse", "--verify", "--end-of-options", `${input.commit}^{tree}`], {
      cwd: input.repository,
      env,
      maxOutputBytes: 1024,
    }),
  ])
  if (
    format.exitCode !== 0 ||
    format.truncated ||
    ref.exitCode !== 0 ||
    ref.truncated ||
    ref.text().trim() !== input.commit ||
    tree.exitCode !== 0 ||
    tree.truncated ||
    tree.text().trim() !== input.tree
  ) {
    return yield* Effect.fail(gitError("revision"))
  }
  return inspectedRevision
})

export const finalizedTree = Effect.fn("ArenaInspection.finalizedTree")(function* (input: FinalizedInput) {
  const configured = yield* Effect.try({
    try: () => boundedLimits(input.limits),
    catch: (error) => (error instanceof Error ? error : new Error("Arena inspection limits are invalid")),
  })
  const git = yield* Git.Service
  const inspectedRevision = yield* verifyFinalized(git, input)
  const result = yield* git.run(["ls-tree", "-r", "-t", "-z", "-l", "--full-tree", input.tree], {
    cwd: input.repository,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
    maxOutputBytes: configured.maxTreeOutputBytes,
  })
  if (result.exitCode !== 0) return yield* Effect.fail(gitError("tree"))

  const parsed = records(result.stdout)
  const entries: TreeEntry[] = []
  let outputBytes = 0
  let truncated = result.truncated || !parsed.complete
  for (const record of parsed.output) {
    if (!record.length) continue
    const entry = parseTreeRecord(record)
    if (!entry) {
      truncated = true
      continue
    }
    if (entry.path.split("/").some((segment) => segment.toLowerCase() === ".git")) continue
    const appended = appendEntry(entries, entry, outputBytes, configured)
    outputBytes = appended.outputBytes
    if (appended.appended) continue
    truncated = true
    break
  }

  return {
    source: "finalized",
    revision: inspectedRevision,
    entries,
    entryCount: entries.length,
    outputBytes,
    truncated,
    limits: { maxEntries: configured.maxTreeEntries, maxOutputBytes: configured.maxTreeOutputBytes },
  } satisfies Tree
})

function finalizedEntry(value: Uint8Array, path: string) {
  const parsed = records(value)
  if (!parsed.complete) throw gitError("file metadata")
  const entry = parsed.output
    .map(parseTreeRecord)
    .filter((item) => item !== undefined)
    .find((item) => item.path === path)
  if (!entry) throw new Error(`Arena inspection path not found: ${path}`)
  return entry
}

export const finalizedFile = Effect.fn("ArenaInspection.finalizedFile")(function* (
  input: FinalizedInput & { readonly path: string },
) {
  const configured = yield* Effect.try({
    try: () => boundedLimits(input.limits),
    catch: (error) => (error instanceof Error ? error : new Error("Arena inspection limits are invalid")),
  })
  const path = yield* Effect.try({
    try: () => repositoryPath(input.path, configured),
    catch: (error) => (error instanceof Error ? error : new Error("Arena inspection path is invalid")),
  })
  const git = yield* Git.Service
  const inspectedRevision = yield* verifyFinalized(git, input)
  const selected = yield* git.run(["ls-tree", "-z", "-l", "--full-tree", input.tree, "--", path], {
    cwd: input.repository,
    env: { GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    maxOutputBytes: 64 * 1024,
  })
  if (selected.exitCode !== 0 || selected.truncated) return yield* Effect.fail(gitError("file metadata"))
  const entry = yield* Effect.try({
    try: () => finalizedEntry(selected.stdout, path),
    catch: (error) => (error instanceof Error ? error : gitError("file metadata")),
  })
  if (entry.type === "directory") return yield* Effect.fail(new Error(`Arena inspection path is a directory: ${path}`))
  if ((entry.type !== "file" && entry.type !== "symlink") || !entry.objectID || entry.size === undefined) {
    return yield* Effect.fail(new Error(`Arena inspection path is not a regular file: ${path}`))
  }

  const result = yield* git.run(["cat-file", "blob", entry.objectID], {
    cwd: input.repository,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
    maxOutputBytes: configured.maxFileBytes + 1,
  })
  if (result.exitCode !== 0) return yield* Effect.fail(gitError("file content"))
  const bytes = result.stdout.subarray(0, configured.maxFileBytes)
  const truncated =
    entry.size > configured.maxFileBytes || result.stdout.length > configured.maxFileBytes || result.truncated
  return {
    source: "finalized",
    revision: inspectedRevision,
    path,
    type: entry.type,
    size: entry.size,
    returnedBytes: bytes.length,
    truncated,
    ...content(bytes, truncated),
    mode: entry.mode,
    objectID: entry.objectID,
    limitBytes: configured.maxFileBytes,
  } satisfies File
})

export * as ArenaInspection from "./inspection"
