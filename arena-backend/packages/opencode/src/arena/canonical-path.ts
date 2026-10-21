import { rewritePathCommand } from "./path-command"
import { fileURLToPath, pathToFileURL } from "node:url"

type CanonicalPaths = { readonly worktrees: readonly string[]; readonly canonical: string }
type LocalPaths = { readonly canonical: string; readonly worktree: string }

// These helpers accept declared path values, not commands or serialized transcript text.
export function canonicalizeWorktreePaths<T>(
  value: T,
  input: { readonly worktrees: readonly string[]; readonly canonical: string },
): T {
  const roots = pathRoots(input.worktrees)
  if (!roots) return value
  return rewrite(value, roots, input.canonical) as T
}

export function localizeCanonicalPaths<T>(
  value: T,
  input: { readonly canonical: string; readonly worktree: string },
): T {
  const roots = pathRoots([input.canonical])
  if (!roots) return value
  return rewrite(value, roots, input.worktree) as T
}

// Ordinary session forks relocate every path mention in their copied objects.
export function localizeEmbeddedPaths<T>(value: T, input: LocalPaths): T {
  if (!input.canonical) return value
  const pattern = new RegExp(`${input.canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`, "g")
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") return entry.replace(pattern, () => input.worktree)
    if (Array.isArray(entry)) return entry.map(visit)
    if (!plainObject(entry)) return entry
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, visit(item)]))
  }
  return visit(value) as T
}

export function canonicalizeWorktreeCommand(command: string, input: CanonicalPaths) {
  return rewritePathCommand(command, (path) => canonicalizeWorktreePaths(path, input))
}

export function localizeCanonicalCommand(command: string, input: LocalPaths) {
  return rewritePathCommand(command, (path) => localizeCanonicalPaths(path, input))
}

export async function canonicalizeTranscriptPaths<T>(value: T, input: CanonicalPaths, role?: string): Promise<T> {
  return transcript(
    value,
    (path) => canonicalizeWorktreePaths(path, input),
    (text) => rewritePathReferences(text, input.worktrees, input.canonical),
    role,
  )
}

export async function localizeTranscriptPaths<T>(value: T, input: LocalPaths, role?: string): Promise<T> {
  return transcript(
    value,
    (path) => localizeCanonicalPaths(path, input),
    (text) => rewritePathReferences(text, [input.canonical], input.worktree),
    role,
  )
}

const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "glob", "grep", "list"])

async function transcript<T>(
  value: T,
  path: (value: string) => string,
  text: (value: string) => string,
  role?: string,
): Promise<T> {
  if (!plainObject(value)) return value
  const fields = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        keys.includes(key) && typeof entry === "string" ? path(entry) : entry,
      ]),
    )
  if (value.role === "assistant" && plainObject(value.path)) {
    return { ...value, path: fields(value.path, ["cwd", "root"]) }
  }
  if (role === "assistant" && value.type === "text" && typeof value.text === "string") {
    const rewritten = text(value.text)
    return rewritten === value.text ? value : { ...value, text: rewritten }
  }
  if (value.role === "user" && plainObject(value.summary) && Array.isArray(value.summary.diffs)) {
    return {
      ...value,
      summary: {
        ...value.summary,
        diffs: value.summary.diffs.map((diff) => (plainObject(diff) ? fields(diff, ["file"]) : diff)),
      },
    }
  }
  if (value.type === "patch" && Array.isArray(value.files)) {
    return { ...value, files: value.files.map((file) => (typeof file === "string" ? path(file) : file)) }
  }
  if (value.type === "file") {
    let url = value.url
    if (typeof url === "string" && url.startsWith("file://")) {
      try {
        const original = fileURLToPath(url)
        const mapped = path(original)
        if (mapped !== original) url = pathToFileURL(mapped).href
      } catch {
        // Invalid attachment URLs are not filesystem paths.
      }
    }
    return {
      ...value,
      url,
      ...(plainObject(value.source) && (value.source.type === "file" || value.source.type === "symbol")
        ? { source: fields(value.source, ["path"]) }
        : {}),
    }
  }
  if (value.type !== "tool" || !plainObject(value.state) || !plainObject(value.state.input)) return value
  const state = Array.isArray(value.state.attachments)
    ? {
        ...value.state,
        attachments: await Promise.all(value.state.attachments.map((attachment) => transcript(attachment, path, text))),
      }
    : value.state
  const input = value.state.input
  if (typeof value.tool === "string" && FILE_TOOLS.has(value.tool)) {
    return { ...value, state: { ...state, input: fields(input, ["path", "filePath", "directory"]) } }
  }
  // This adapter owns POSIX bash inputs. Other tools and free-form text retain their original bytes.
  if (value.tool !== "bash" || process.platform === "win32" || typeof input.command !== "string") {
    return state === value.state ? value : { ...value, state }
  }
  const command = await rewritePathCommand(input.command, path)
  let output = state.output
  if (typeof output === "string") {
    if (input.command.trim() === "pwd") {
      const ending = output.endsWith("\n") ? "\n" : ""
      const original = ending ? output.slice(0, -1) : output
      output = path(original) + ending
    } else {
      output = await rewritePathCommand(output, path, true)
    }
  }
  return {
    ...value,
    state: {
      ...state,
      input: { ...fields(input, ["workdir"]), command },
      ...(typeof output === "string" ? { output } : {}),
    },
  }
}

const ARENA_PORT_ALIASES = ["PASEO_PORT", "PASEO_PORT2", "PASEO_PORT3"] as const
type ArenaPortAlias = (typeof ARENA_PORT_ALIASES)[number]

/** The port bank and preview URLs one contestant ran with. */
export type ArenaEnvironment = {
  readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
  readonly previewUrls?: Partial<Record<ArenaPortAlias, string>>
}

/**
 * Where a canonical text part keeps the text the winner wrote, before its ports became variables.
 * The daemon shows this to the reader; the model reads only `text`. Assistant text metadata goes
 * to the provider as provider metadata on the next call, which must map names to objects, so the
 * text is nested one level down.
 */
export const DISPLAY_METADATA_KEY = "arenaDisplay"

// The loopback hosts a contestant names its own listener by. A port number anywhere else (a PID, a
// hash, a line number, a remote host) is left alone.
const LOOPBACK_PORT = /(?<![\w.-])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)(?!\w)/g

/**
 * Replace the winner's own ports and preview URLs with the variables that name them, so a later
 * contestant reads its own values there. Only the host:port and full preview URL forms change.
 * Idempotent: no variable matches again.
 */
export function canonicalizeEnvironmentText(text: string, environment: ArenaEnvironment): string {
  const result = ARENA_PORT_ALIASES.reduce((current, alias) => {
    const url = environment.previewUrls?.[alias]
    if (!url) return current
    const variable = `$ARENA_PREVIEW_URL${alias.slice("PASEO_PORT".length)}`
    // Not when the host or port carries on: `:67689` or `.localhost.example` is another origin.
    const pattern = new RegExp(`${escapeRegExp(url)}(?![\\w-]|[.:]\\w)`, "g")
    return current.replace(pattern, () => variable)
  }, text)
  const variables = new Map(
    ARENA_PORT_ALIASES.flatMap((alias) => {
      const port = environment.portAliases?.[alias]
      return port ? [[String(port), `$${alias}`] as const] : []
    }),
  )
  if (variables.size === 0) return result
  return result.replace(LOOPBACK_PORT, (match, host: string, port: string) => {
    const variable = variables.get(port)
    return variable ? `${host}:${variable}` : match
  })
}

/**
 * The winner's prose as the canonical session keeps it. Only assistant text parts change: reasoning
 * carries signatures, tool inputs must keep matching what ran and what is on disk, and tool output
 * records what happened. The text the winner wrote stays under DISPLAY_METADATA_KEY.
 */
export function canonicalizeEnvironmentProse<T>(part: T, role: string | undefined, environment: ArenaEnvironment): T {
  if (role !== "assistant" || !plainObject(part) || part.type !== "text" || typeof part.text !== "string") return part
  const text = canonicalizeEnvironmentText(part.text, environment)
  if (text === part.text) return part
  const metadata = plainObject(part.metadata) ? part.metadata : {}
  // A display text the run already set (`displayEnvironmentProse`) is what the reader saw.
  const display = displayText(part) ?? part.text
  return { ...part, text, metadata: { ...metadata, [DISPLAY_METADATA_KEY]: { text: display } } } as T
}

// `$NAME` or `${NAME}`, not when the name carries on (`$PASEO_PORTS`, `$ARENA_PREVIEW_URL_OLD`).
const VARIABLE = /\$(?:\{(PASEO_PORT[23]?|ARENA_PREVIEW_URL[23]?)\}|(PASEO_PORT[23]?|ARENA_PREVIEW_URL[23]?)(?!\w))/g

// Markdown code: a fenced block, or an inline span.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/

/**
 * This run's values for the port and preview variables in `text`, for the reader. Code stays as
 * written: there a variable is a name the contestant talks about or a command the shell expands.
 */
export function expandEnvironmentText(text: string, environment: ArenaEnvironment): string {
  return text
    .split(CODE)
    .map((segment, index) => (index % 2 === 1 ? segment : expandProse(segment, environment)))
    .join("")
}

function expandProse(text: string, environment: ArenaEnvironment): string {
  return text.replace(VARIABLE, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ""
    if (name.startsWith("PASEO_PORT")) {
      const port = environment.portAliases?.[name as ArenaPortAlias]
      return port ? String(port) : match
    }
    const alias = `PASEO_PORT${name.slice("ARENA_PREVIEW_URL".length)}` as ArenaPortAlias
    return environment.previewUrls?.[alias] ?? match
  })
}

/**
 * A contestant reads `$ARENA_PREVIEW_URL` and `$PASEO_PORT` in the history and can write them in its
 * own prose, where the reader needs a link. When a run ends, its assistant text parts that name one
 * keep `text` as written, which is what later contestants read, and get this run's values under
 * DISPLAY_METADATA_KEY for the panes and the chat.
 */
export function displayEnvironmentProse<T>(part: T, role: string | undefined, environment: ArenaEnvironment): T {
  if (role !== "assistant" || !plainObject(part) || part.type !== "text" || typeof part.text !== "string") return part
  const display = expandEnvironmentText(part.text, environment)
  if (display === part.text) return part
  const metadata = plainObject(part.metadata) ? part.metadata : {}
  return { ...part, metadata: { ...metadata, [DISPLAY_METADATA_KEY]: { text: display } } } as T
}

function displayText(part: Record<string, unknown>) {
  const display = plainObject(part.metadata) ? part.metadata[DISPLAY_METADATA_KEY] : undefined
  return plainObject(display) && typeof display.text === "string" ? display.text : undefined
}

function pathRoots(worktrees: readonly string[]) {
  const roots = worktrees.filter(Boolean).toSorted((left, right) => right.length - left.length)
  return roots.length ? roots : undefined
}

function mapPath(value: string, roots: readonly string[], destination: string): string {
  for (const root of roots) {
    if (value === root) return destination
    if (!value.startsWith(root === "/" ? "/" : `${root}/`)) continue
    const suffix = value.slice(root.length)
    // Resolving .. across a relocated root (or a symlink) can change which directory it names.
    if (suffix.split("/").includes("..")) return value
    return root === "/" ? `${destination.replace(/\/$/, "")}/${suffix}` : destination + suffix
  }
  return value
}

// Assistant text is continuation context. Retarget complete old-root path references without
// changing user prompts, tool output, or strings that only share a path prefix.
function rewritePathReferences(value: string, worktrees: readonly string[], destination: string): string {
  const roots = pathRoots(worktrees)
  if (!roots) return value
  let result = ""
  let cursor = 0
  while (cursor < value.length) {
    let start = -1
    let root = ""
    for (const candidate of roots) {
      const found = value.indexOf(candidate, cursor)
      if (found !== -1 && (start === -1 || found < start || (found === start && candidate.length > root.length))) {
        start = found
        root = candidate
      }
    }
    if (start === -1) break
    const before = value[start - 1]
    const after = value[start + root.length]
    if (
      (before !== undefined && !/[\s"'`([{=:]/.test(before)) ||
      (after !== undefined && after !== "/" && !/[\s"'`)\]};,!?]/.test(after))
    ) {
      result += value.slice(cursor, start + root.length)
      cursor = start + root.length
      continue
    }
    let end = start + root.length
    while (end < value.length && !/[\s"'`<>()[\]{},;!?]/.test(value[end]!)) end++
    const original = value.slice(start, end)
    result += value.slice(cursor, start) + mapPath(original, [root], destination)
    cursor = end
  }
  return result + value.slice(cursor)
}

function rewrite(value: unknown, roots: readonly string[], canonical: string): unknown {
  if (typeof value === "string") return mapPath(value, roots, canonical)
  if (Array.isArray(value)) return value.map((entry) => rewrite(entry, roots, canonical))
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, roots, canonical)]))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Anything with a non-trivial prototype (Date, Uint8Array, BSON values) is passed through untouched
// rather than flattened into a plain object.
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as ArenaCanonicalPath from "./canonical-path"
