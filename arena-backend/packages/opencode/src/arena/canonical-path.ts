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

/** One run's port bank and the preview URLs routed to it. */
export type ArenaEnvironmentBank = {
  readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
  readonly previewUrls?: Partial<Record<ArenaPortAlias, string>>
}

/**
 * The canonical messages one turn's winner wrote and the environment it wrote them in: from the
 * turn's `canonicalUserMessageID` through the last message its graft copied. A turn grafted before
 * that end marker was recorded runs until the next battle's first message.
 */
export type ArenaTurnEnvironment = {
  readonly from: string
  readonly through?: string
  readonly environment: ArenaEnvironmentBank
}

type TurnRecord = {
  readonly _id: string
  readonly appliedSide?: string
  readonly canonicalUserMessageID?: string
  readonly canonicalGraftedThroughMessageID?: string
}
type RunRecord = {
  readonly turnID: string
  readonly side: string
  readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
  readonly services?: readonly { readonly proxyRoutes: readonly { readonly alias?: ArenaPortAlias; readonly url?: string }[] }[]
}

export function arenaTurnEnvironments(
  turns: readonly TurnRecord[],
  runs: readonly RunRecord[],
): ArenaTurnEnvironment[] {
  return turns
    .flatMap((turn) => {
      if (!turn.appliedSide || !turn.canonicalUserMessageID) return []
      const winner = runs.find((run) => run.turnID === turn._id && run.side === turn.appliedSide)
      if (!winner) return []
      const previewUrls = Object.fromEntries(
        (winner.services ?? []).flatMap((service) =>
          service.proxyRoutes.flatMap((route) => (route.alias && route.url ? [[route.alias, route.url]] : [])),
        ),
      )
      return [
        {
          from: turn.canonicalUserMessageID,
          ...(turn.canonicalGraftedThroughMessageID ? { through: turn.canonicalGraftedThroughMessageID } : {}),
          environment: { ...(winner.portAliases ? { portAliases: winner.portAliases } : {}), previewUrls },
        },
      ]
    })
    .toSorted((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0))
}

/** The environment of the run whose graft wrote this canonical message, if a battle run wrote it. */
export function producingArenaEnvironment(messageID: string, turns: readonly ArenaTurnEnvironment[]) {
  let producing: ArenaTurnEnvironment | undefined
  for (const turn of turns) {
    if (turn.from <= messageID && (!producing || turn.from > producing.from)) producing = turn
  }
  if (!producing) return undefined
  if (producing.through !== undefined && messageID > producing.through) return undefined
  return producing.environment
}

/**
 * Retargets one copied part for a contestant: the producing run's literal ports and preview URLs
 * become this contestant's own, in one pass. Variables the agent wrote (`$PASEO_PORT`) already
 * name the current environment and stay as written. User messages and parts no battle run wrote
 * are unchanged.
 */
export function retargetArenaTranscriptPart<T>(
  part: T,
  input: {
    readonly role: string
    readonly producedIn: ArenaEnvironmentBank | undefined
    readonly env: Readonly<Record<string, string>>
  },
): T {
  if (input.role !== "assistant" || !input.producedIn) return part
  return rewriteEnvironment(part, input.producedIn, (name) => input.env[name] || `$${name}`)
}

/** Replaces one run's literal ports and preview URLs, in port contexts only, with their variables. */
export function canonicalizeArenaEnvironment<T>(part: T, bank: ArenaEnvironmentBank): T {
  return rewriteEnvironment(part, bank, (name) => `$${name}`)
}

/**
 * A contestant's finished answer can name its preview by variable. The chat shows the answer, so
 * the URL is expanded there; a later contestant still gets its own, since preview URLs are matched
 * whole. Port variables stay as written: a bare port number has no context to be retargeted by.
 */
export function localizeArenaPreviewUrls<T>(part: T, env: Readonly<Record<string, string>>): T {
  if (!plainObject(part) || part.type !== "text") return part
  return rewriteAgentFields(part, (value) => expandVariables(value, env, PREVIEW_URL_VARIABLES))
}

const PREVIEW_URL_VARIABLES = ARENA_PORT_ALIASES.map((alias) => `ARENA_PREVIEW_URL${alias.slice("PASEO_PORT".length)}`)

// `target` gets the environment variable a literal stands for (`PASEO_PORT2`, `ARENA_PREVIEW_URL`).
function rewriteEnvironment<T>(part: T, bank: ArenaEnvironmentBank, target: (name: string) => string): T {
  const urls = ARENA_PORT_ALIASES.flatMap((alias) => {
    const url = bank.previewUrls?.[alias]?.replace(/\/+$/, "")
    return url ? [{ url, name: `ARENA_PREVIEW_URL${alias.slice("PASEO_PORT".length)}` }] : []
  })
    .toSorted((left, right) => right.url.length - left.url.length)
    .map(({ url, name }) => ({ pattern: new RegExp(`(?<![\\w.+-])()${escapeRegExp(url)}(?![\\w-])`, "g"), name }))
  const ports = ARENA_PORT_ALIASES.flatMap((alias) => {
    const port = bank.portAliases?.[alias]
    return port ? [{ pattern: portPattern(port), name: alias as string }] : []
  })
  // Whole preview URLs first: their own port is the proxy's, never a run's.
  const replacements = [...urls, ...ports]
  if (replacements.length === 0) return part
  return rewriteAgentFields(part, (value) => {
    // One pass over the original text: a value written for one literal is never matched again,
    // so a port a later bank reuses cannot be rewritten twice.
    const found = replacements
      .flatMap(({ pattern, name }) =>
        [...value.matchAll(pattern)].map((match) => ({
          start: match.index + match[1]!.length,
          end: match.index + match[0].length,
          name,
        })),
      )
      .toSorted((left, right) => left.start - right.start)
    let result = ""
    let cursor = 0
    for (const match of found) {
      if (match.start < cursor) continue
      result += value.slice(cursor, match.start) + target(match.name)
      cursor = match.end
    }
    return found.length === 0 ? value : result + value.slice(cursor)
  })
}

function expandVariables(value: string, env: Readonly<Record<string, string>>, names: readonly string[]) {
  return value.replace(/\$([A-Z][A-Z0-9_]*)/g, (match, name: string) =>
    names.includes(name) && env[name] ? env[name] : match,
  )
}

// Text that puts a port number where only a port belongs. A bare number is left alone: it can be a
// PID, a size, part of a hash or an ID, and the port it may once have been is unknowable.
const PORT_CONTEXTS = [
  // localhost:N, http://127.0.0.1:N/path, [::1]:N, name.localhost:N
  String.raw`(?<![\w.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost):`,
  // --port N, --port=N, -p N
  String.raw`(?<![\w-])(?:--port|-p)(?:=|[ \t]+)`,
  // PORT=N, PASEO_PORT2=N, VITE_PORT="N"
  String.raw`(?<!\w)(?:\w*_)?port\d*=["']?`,
  // lsof -i :N, lsof -iTCP:N
  String.raw`(?<![\w-])-i[ \t]*(?:tcp|udp)?:`,
  // port N, Port: N, "port": N. Not "ports: N, M": only the first number of a list would match,
  // and a list with one value changed names ports from two environments.
  String.raw`(?<!\w)port["']?[ \t]*[:=]?[ \t]*`,
].join("|")

function portPattern(port: number) {
  return new RegExp(`(${PORT_CONTEXTS})${port}(?!\\d)`, "gi")
}

// The fields a contestant wrote that later turns read as instructions: its answer, the shell
// commands it ran and the URLs it fetched. Everything else is left byte for byte: reasoning is
// signed or encrypted with its text, tool output is what a program printed in an environment that
// is gone, file edits must still match the files, and IDs, hashes and metadata are not prose.
const AGENT_TOOL_FIELDS = new Map<string, readonly string[]>([
  ["bash", ["command", "workdir"]],
  ["webfetch", ["url"]],
])

function rewriteAgentFields<T>(part: T, rewrite: (value: string) => string): T {
  if (!plainObject(part)) return part
  const field = (value: unknown) => (typeof value === "string" && !encodedBytes(value) ? rewrite(value) : value)
  if (part.type === "text") {
    const text = field(part.text)
    return text === part.text ? part : ({ ...part, text } as T)
  }
  if (part.type !== "tool" || typeof part.tool !== "string") return part
  const keys = AGENT_TOOL_FIELDS.get(part.tool)
  if (!keys || !plainObject(part.state) || !plainObject(part.state.input)) return part
  const input = part.state.input
  const changed = Object.fromEntries(
    keys.flatMap((key) => {
      const next = field(input[key])
      return next === input[key] ? [] : [[key, next]]
    }),
  )
  if (Object.keys(changed).length === 0) return part
  return { ...part, state: { ...part.state, input: { ...input, ...changed } } } as T
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A data URL carries encoded bytes, a screenshot a contestant read for one. Its base64 text can hold a
// port's digits between two letters, and rewriting them corrupted the image, so every later battle
// of the chat sent an image no provider would decode.
function encodedBytes(value: string) {
  return value.startsWith("data:")
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

// Anything with a non-trivial prototype (Date, Uint8Array, BSON values) is passed through untouched
// rather than flattened into a plain object.
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as ArenaCanonicalPath from "./canonical-path"
