import { rewritePathCommand } from "./path-command"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isolatedRoot, LOCAL_STATE_DIRNAME } from "@/worktree/layout"

type CanonicalPaths = { readonly worktrees: readonly string[]; readonly canonical: string }

/**
 * What a winner's transcript can name that will be gone, or someone else's, by the next turn: the
 * contestant temp directories under `temp`, and every Arena worktree inside the checkout. `home`
 * adds the `~` and `$HOME` spellings of the checkout.
 */
type ArenaRoots = CanonicalPaths & { readonly temp: string; readonly home?: string }
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

/**
 * The winner's transcript as the chat keeps it. Declared paths are retargeted field by field, then
 * every other string the model will read again, tool output and reasoning included, has its Arena
 * references replaced (`retargetArenaReferences`), so no later turn is handed a path into a worktree
 * that is gone, recycled into another side's, or the other side's own. Text the user typed stays as
 * written.
 */
export async function canonicalizeTranscriptPaths<T>(value: T, input: ArenaRoots, role?: string): Promise<T> {
  const declared = await transcript(
    value,
    (path) => canonicalizeWorktreePaths(path, input),
    (text) => rewritePathReferences(text, input.worktrees, input.canonical),
    role,
  )
  if (plainObject(declared) && declared.type === "text" && role === "user" && declared.synthetic !== true) {
    return declared
  }
  const references = arenaReferences(input)
  return deepRewrite(declared, (text) => {
    if (encodedBytes(text)) return text
    return references(rewritePathReferences(text, input.worktrees, input.canonical))
  }) as T
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

export function canonicalizeArenaEnvironment<T>(
  value: T,
  input: {
    readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
    readonly previewUrls?: Partial<Record<ArenaPortAlias, string>>
  },
): T {
  const replacements = ARENA_PORT_ALIASES.flatMap((alias) => {
    const suffix = alias === "PASEO_PORT" ? "" : alias.slice("PASEO_PORT".length)
    const url = input.previewUrls?.[alias]
    const port = input.portAliases?.[alias]
    return [
      ...(url ? [{ literal: url, variable: `$ARENA_PREVIEW_URL${suffix}`, numeric: false }] : []),
      ...(port ? [{ literal: String(port), variable: `$${alias}`, numeric: true }] : []),
    ]
  }).toSorted((left, right) => right.literal.length - left.literal.length)
  if (replacements.length === 0) return value
  return rewriteEnvironment(value, replacements) as T
}

export function localizeArenaEnvironment<T>(value: T, env: Readonly<Record<string, string>>): T {
  const replacements = [
    ...ARENA_PORT_ALIASES.map((alias) => ({ variable: `$${alias}`, literal: env[alias] })),
    ...ARENA_PORT_ALIASES.map((alias) => {
      const suffix = alias === "PASEO_PORT" ? "" : alias.slice("PASEO_PORT".length)
      const name = `ARENA_PREVIEW_URL${suffix}`
      return { variable: `$${name}`, literal: env[name] }
    }),
  ]
    .filter((replacement): replacement is { variable: string; literal: string } => !!replacement.literal)
    // `$PASEO_PORT` is a prefix of `$PASEO_PORT2`; replace the longest names first.
    .toSorted((left, right) => right.variable.length - left.variable.length)
  if (replacements.length === 0) return value
  return rewriteVariables(value, replacements) as T
}

/**
 * Replaces what a transcript string names of Arena's own: a worktree slot of the checkout's pool
 * (`<checkout>/.agent-duel/worktrees/<chat>/<slot>`, any turn, either side, spare) becomes the
 * checkout, its host repository (`<slot>.git`) the checkout's `.git`, and a contestant temp
 * directory `$TMPDIR`, since the next side has its own and the old one is deleted with its run.
 * Matched wherever they appear: after `file://`, under `/private`, behind `../`, or spelled from
 * `~` or `$HOME`. The pool's own directory, which names no slot, is left as it is.
 */
function arenaReferences(input: ArenaRoots): (text: string) => string {
  const pool = isolatedRoot(input.canonical).slice(input.canonical.length)
  const spellings = [
    privateOptional(input.canonical),
    ...(input.home && input.canonical.startsWith(input.home + "/")
      ? ["~", "\\$HOME", "\\$\\{HOME\\}"].map((home) => home + escapeRegExp(input.canonical.slice(input.home!.length)))
      : []),
    ...(encodeURI(input.canonical) === input.canonical ? [] : [escapeRegExp(encodeURI(input.canonical))]),
  ]
  const slot = new RegExp(
    `(?:${spellings.join("|")})${escapeRegExp(pool)}/[^/\\s"'\`<>()[\\]{},;:!?#*]+/[^/\\s"'\`<>()[\\]{},;:!?#*]+?(\\.git)?(?=$|[/\\s"'\`<>()[\\]{},;:!?#*])`,
    "g",
  )
  const temp = new RegExp(`${privateOptional(input.temp)}/ses_[0-9A-Za-z]+(?![0-9A-Za-z])`, "g")
  return (text) =>
    text
      .replace(slot, (_match, git: string | undefined) => (git ? `${input.canonical}/.git` : input.canonical))
      .replace(temp, () => "$TMPDIR")
}

// macOS reports `/tmp` and `/var` paths under `/private` as well; match a path in either spelling.
function privateOptional(directory: string) {
  const bare = directory.replace(/^\/private(?=\/(?:tmp|var)\/)/, "")
  return /^\/(?:tmp|var)\//.test(bare) ? `(?:/private)?${escapeRegExp(bare)}` : escapeRegExp(bare)
}

// Returns `value` itself when nothing in it changed.
function deepRewrite(value: unknown, text: (value: string) => string): unknown {
  if (typeof value === "string") return text(value)
  if (Array.isArray(value)) {
    const next = value.map((entry) => deepRewrite(entry, text))
    return next.some((entry, index) => entry !== value[index]) ? next : value
  }
  if (!plainObject(value)) return value
  const entries = Object.entries(value).map(([key, entry]) => [key, entry, deepRewrite(entry, text)] as const)
  if (entries.every(([, before, after]) => before === after)) return value
  return Object.fromEntries(entries.map(([key, , after]) => [key, after]))
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
    // Arena's own state is not part of the tree a root maps to: a checkout path into its worktree
    // pool would become a path inside the contestant's own worktree that does not exist.
    if (suffix === `/${LOCAL_STATE_DIRNAME}` || suffix.startsWith(`/${LOCAL_STATE_DIRNAME}/`)) return value
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

// A data URL carries encoded bytes, a screenshot a contestant read for one. Its base64 text can hold a
// port's digits between two letters, and rewriting them corrupted the image, so every later battle
// of the chat sent an image no provider would decode.
function encodedBytes(value: string) {
  return value.startsWith("data:")
}

function rewriteEnvironment(
  value: unknown,
  replacements: readonly { readonly literal: string; readonly variable: string; readonly numeric: boolean }[],
): unknown {
  if (typeof value === "string") {
    if (encodedBytes(value)) return value
    return replacements.reduce((current, replacement) => {
      if (!replacement.numeric) return current.split(replacement.literal).join(replacement.variable)
      const pattern = new RegExp(`(?<!\\d)${escapeRegExp(replacement.literal)}(?!\\d)`, "g")
      return current.replace(pattern, () => replacement.variable)
    }, value)
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteEnvironment(entry, replacements))
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteEnvironment(entry, replacements)]))
}

function rewriteVariables(
  value: unknown,
  replacements: readonly { readonly variable: string; readonly literal: string }[],
): unknown {
  if (typeof value === "string") {
    if (encodedBytes(value)) return value
    return replacements.reduce(
      (current, replacement) => current.split(replacement.variable).join(replacement.literal),
      value,
    )
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteVariables(entry, replacements))
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteVariables(entry, replacements)]))
}

// Anything with a non-trivial prototype (Date, Uint8Array, BSON values) is passed through untouched
// rather than flattened into a plain object.
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as ArenaCanonicalPath from "./canonical-path"
