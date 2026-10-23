/**
 * A contestant's copy of the chat's history is retargeted from the port bank of the run that wrote
 * each message to the contestant's own bank. Answers, reasoning without a signature, and every tool's
 * input, output and error follow one rule: every standalone number equal to one of the producing
 * run's ports changes, and so do whole preview URLs and preview hosts.
 *
 * Never changed: user messages, files and attachments, tool metadata, titles and IDs, `data:` URIs,
 * base64 and long hex runs, UUIDs, JSON documents longer than `MAX_REWRITTEN_JSON`, and binary
 * output.
 */

const PORT_ALIASES = ["PASEO_PORT", "PASEO_PORT2", "PASEO_PORT3"] as const
type PortAlias = (typeof PORT_ALIASES)[number]

/** One run's port bank and the preview URLs routed to it. */
export type ArenaEnvironmentBank = {
  readonly portAliases?: Partial<Record<PortAlias, number>>
  readonly previewUrls?: Partial<Record<PortAlias, string>>
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
  readonly portAliases?: Partial<Record<PortAlias, number>>
  readonly services?: readonly {
    readonly proxyRoutes: readonly { readonly alias?: PortAlias; readonly url?: string }[]
  }[]
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

type Env = Readonly<Record<string, string | undefined>>
type Range = readonly [start: number, end: number]
type Rewrite = (value: string) => string

/**
 * Retargets one copied part for a contestant: the producing run's literal ports and preview URLs
 * become this contestant's own, in one pass over the original text, so a new port that equals an
 * old port of the same bank is never rewritten twice. Variables the agent wrote (`$PASEO_PORT`)
 * already name the current environment and stay as written. User messages and parts no battle run
 * wrote are unchanged.
 */
export function retargetArenaTranscriptPart<T>(
  part: T,
  input: { readonly role: string; readonly producedIn: ArenaEnvironmentBank | undefined; readonly env: Env },
): T {
  if (input.role !== "assistant" || !input.producedIn || !plainObject(part)) return part
  const rewrite = rewriter(input.producedIn, input.env)
  if (!rewrite) return part
  return retargetPart(part, rewrite) as T
}

/**
 * A contestant's finished answer can name its preview by variable. The chat shows the answer, so
 * the URL is expanded there; a later contestant still gets its own, since preview URLs are matched
 * whole. Port variables stay as written.
 */
export function localizeArenaPreviewUrls<T>(part: T, env: Env): T {
  if (!plainObject(part) || part.type !== "text" || typeof part.text !== "string") return part
  const text = part.text.replace(/\$(ARENA_PREVIEW_URL[23]?)(?![\w])/g, (match, name: string) => env[name] || match)
  return text === part.text ? part : ({ ...part, text } as T)
}

function retargetPart(part: Record<string, unknown>, rewrite: Rewrite): Record<string, unknown> {
  if (part.type === "text") return withField(part, "text", rewrite)
  // Agent Duel saves reasoning without its metadata (`arena/privacy.ts`), so a fork never copies a
  // signature. One that does carry metadata is signed or encrypted with its text and stays as is.
  if (part.type === "reasoning") return hasEntries(part.metadata) ? part : withField(part, "text", rewrite)
  if (part.type === "tool") return retargetTool(part, rewrite)
  return part
}

function withField(part: Record<string, unknown>, key: string, rewrite: Rewrite) {
  const value = part[key]
  if (typeof value !== "string") return part
  const next = rewrite(value)
  return next === value ? part : { ...part, [key]: next }
}

function retargetTool(part: Record<string, unknown>, rewrite: Rewrite) {
  const state = part.state
  if (!plainObject(state)) return part
  const next: Record<string, unknown> = {}
  for (const key of ["input", "output", "error"]) {
    const rewritten = mapValue(state[key], rewrite)
    if (rewritten !== state[key]) next[key] = rewritten
  }
  if (Object.keys(next).length === 0) return part
  return { ...part, state: { ...state, ...next } }
}

/** Rewrites every string under `value`. */
function mapValue(value: unknown, rewrite: Rewrite): unknown {
  if (typeof value === "string") return rewrite(value)
  if (Array.isArray(value)) {
    const next = value.map((entry) => mapValue(entry, rewrite))
    return next.some((entry, index) => entry !== value[index]) ? next : value
  }
  if (plainObject(value)) {
    const entries = Object.entries(value).map(([key, entry]) => [key, mapValue(entry, rewrite)] as const)
    return entries.some(([key, entry]) => entry !== value[key]) ? Object.fromEntries(entries) : value
  }
  return value
}

function rewriter(bank: ArenaEnvironmentBank, env: Env): Rewrite | undefined {
  const ports = new Map<string, string>()
  for (const alias of PORT_ALIASES) {
    const port = bank.portAliases?.[alias]
    if (port) ports.set(String(port), env[alias] || `$${alias}`)
  }
  const previews = PORT_ALIASES.flatMap((alias) => {
    const name = `ARENA_PREVIEW_URL${alias.slice("PASEO_PORT".length)}`
    const old = origin(bank.previewUrls?.[alias])
    if (!old) return []
    return [{ old, current: origin(env[name]), variable: `$${name}` }]
  }).toSorted((left, right) => right.old.hostname.length - left.old.hostname.length)
  if (ports.size === 0 && previews.length === 0) return undefined
  const patterns = previews.map((preview) => ({
    ...preview,
    pattern: new RegExp(
      String.raw`(?<![\w.-])(https?:\/\/)?${escapeRegExp(preview.old.hostname)}(?::(\d+))?(?![\w-]|\.\w|:\d)`,
      "gi",
    ),
  }))
  return (value) => {
    if (opaque(value)) return value
    const found: Match[] = []
    for (const preview of patterns) {
      for (const match of value.matchAll(preview.pattern)) {
        const scheme = match[1]
        const port = match[2]
        const replacement = preview.current
          ? `${scheme ? `${preview.current.protocol}//` : ""}${preview.current.hostname}${(scheme || port) && preview.current.port ? `:${preview.current.port}` : ""}`
          : scheme
            ? preview.variable
            : undefined
        if (replacement !== undefined) found.push({ start: match.index, end: match.index + match[0].length, replacement })
      }
    }
    found.push(...standalonePorts(value, ports))
    if (found.length === 0) return value
    return apply(value, found, protectedRanges(value))
  }
}

type Match = { readonly start: number; readonly end: number; readonly replacement: string }

// One pass over the original: matches are found first, then applied left to right, so a value
// written for one literal is never matched again.
function apply(value: string, found: readonly Match[], keep: readonly Range[]) {
  const usable = found
    .filter((match) => !keep.some(([start, end]) => match.start < end && match.end > start))
    .toSorted((left, right) => left.start - right.start || right.end - left.end)
  let result = ""
  let cursor = 0
  for (const match of usable) {
    if (match.start < cursor) continue
    result += value.slice(cursor, match.start) + match.replacement
    cursor = match.end
  }
  return cursor === 0 && usable.length === 0 ? value : result + value.slice(cursor)
}

const WORD = /[A-Za-z0-9_]/
const LETTER = /[A-Za-z_]/

/**
 * Any number equal to a port, unless it is part of a name: glued to a letter, digit or
 * underscore (`ord_ab51101`), a dashed name (`req-51101-ab12`, `web-51101.txt`), a version or file
 * extension (`1.51101.0`, `51101.txt`), or a path segment (`/proc/51101`). A slash between two
 * numbers is a list (`51101/51102/51103`), whose values all change together.
 */
function standalonePorts(value: string, ports: ReadonlyMap<string, string>): Match[] {
  return [...value.matchAll(/\d+/g)].flatMap((match) => {
    const replacement = ports.get(match[0])
    if (replacement === undefined) return []
    const start = match.index
    const end = start + match[0].length
    const before = value[start - 1] ?? ""
    const before2 = value[start - 2] ?? ""
    const after = value[end] ?? ""
    const after2 = value[end + 1] ?? ""
    if (WORD.test(before) || WORD.test(after) || (before === "/" && !/\d/.test(before2))) return []
    if ((before === "." && WORD.test(before2)) || (before === "-" && LETTER.test(before2))) return []
    if ((after === "." && WORD.test(after2)) || (after === "-" && LETTER.test(after2))) return []
    return [{ start, end, replacement }]
  })
}

// A data URL carries encoded bytes, a screenshot a contestant read for one. Its base64 text can hold a
// port's digits between two letters, and rewriting them corrupted the image, so every later battle
// of the chat sent an image no provider would decode. Binary output is bytes, not text.
function opaque(value: string) {
  return value.startsWith("data:") || value.includes("\u0000") || value.includes("�")
}

/** Spans inside a string that are data, not prose: they keep every byte. */
export function protectedRanges(value: string): Range[] {
  const ranges: Range[] = []
  const add = (pattern: RegExp, accept: (text: string) => boolean = () => true) => {
    for (const match of value.matchAll(pattern)) {
      if (accept(match[0])) ranges.push([match.index, match.index + match[0].length])
    }
  }
  add(/data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+(?:=[\w.+-]*)?)*,[^\s"'<>)\]]*/gi)
  for (const match of value.matchAll(/[A-Za-z0-9+/]{20,}={0,2}/g)) {
    if (!base64Like(match[0])) continue
    // `localhost:51101/SomePath2` is a port and a path, not encoded bytes.
    const lead = /^\d+\//.exec(match[0])?.[0].length ?? 0
    ranges.push([match.index + lead, match.index + match[0].length])
  }
  add(/(?<![A-Za-z0-9])[0-9a-f]{12,}(?![A-Za-z0-9])/gi)
  add(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
  ranges.push(...jsonRanges(value).filter(([start, end]) => end - start > MAX_REWRITTEN_JSON))
  return ranges
}

// Base64 mixes cases and digits and has few slashes; a path has a slash every few characters.
function base64Like(run: string) {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) return false
  const slashes = run.split("/").length - 1
  return slashes * 12 <= run.length
}

const MAX_JSON = 1_000_000

/**
 * A short JSON document is a command's own result (the URL a browser tool opened, a mock rule it
 * added) and changes like the rest of the output. A long one is data a program wrote or reads (an
 * API response, a dump) and keeps every byte.
 */
const MAX_REWRITTEN_JSON = 2500

/** JSON documents inside a string: the whole string, or any `{"…` / `[…` span that parses. */
function jsonRanges(value: string): Range[] {
  const trimmed = value.trim()
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed) && parses(trimmed)) return [[0, value.length]]
  const ranges: Range[] = []
  const opening = /\{\s*["}]|\[\s*["{[\]\d-]/g
  let budget = MAX_JSON
  let match: RegExpExecArray | null
  while ((match = opening.exec(value)) && budget > 0) {
    const start = match.index
    const end = closing(value, start, budget)
    budget -= (end ?? value.length) - start
    if (end !== undefined && parses(value.slice(start, end))) {
      ranges.push([start, end])
      opening.lastIndex = end
    }
  }
  return ranges
}

function parses(text: string) {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null
  } catch {
    return false
  }
}

// The index after the bracket that closes the one at `start`, reading JSON strings as strings.
function closing(value: string, start: number, budget: number) {
  let depth = 0
  let string = false
  const limit = Math.min(value.length, start + budget)
  for (let index = start; index < limit; index++) {
    const character = value[index]
    if (string) {
      if (character === "\\") index++
      else if (character === '"') string = false
      continue
    }
    if (character === '"') string = true
    else if (character === "{" || character === "[") depth++
    else if (character === "}" || character === "]") {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

function origin(url: string | undefined) {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return { protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port }
  } catch {
    return undefined
  }
}

function hasEntries(value: unknown) {
  return plainObject(value) && Object.keys(value).length > 0
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as ArenaPortRetarget from "./port-retarget"
