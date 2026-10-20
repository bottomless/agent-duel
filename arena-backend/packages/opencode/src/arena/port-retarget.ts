/**
 * A contestant's copy of the chat's history is retargeted from the port bank of the run that wrote
 * each message to the contestant's own bank. Everything may change except a blacklist, and text and
 * tool calls are matched differently:
 *
 * - Text (answers, reasoning without a signature, a subagent's answer): every standalone number
 *   equal to one of the producing run's ports.
 * - Tool calls (inputs, outputs and errors): only numbers in a port context (`localhost:N`,
 *   `--port N`, `PORT=N`, `lsof -i :N`, `listening on port N`, ...).
 * - Both: whole preview URLs and preview hosts.
 *
 * Never changed: user messages, files and attachments, tool metadata and IDs, `data:` URIs, base64
 * and long hex runs, UUIDs, JSON, binary output, the content of files that are not logs (`read`
 * output, `write`/`edit`/`apply_patch` input, `grep` matches, shell reads and writes of a file),
 * and `websearch` output.
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
type Rewrite = (value: string, keep?: readonly Range[]) => string
type Tiers = { readonly text: Rewrite; readonly tool: Rewrite }

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
  const tiers = rewriters(input.producedIn, input.env)
  if (!tiers) return part
  return retargetPart(part, tiers) as T
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

function retargetPart(part: Record<string, unknown>, tiers: Tiers): Record<string, unknown> {
  if (part.type === "text") return withField(part, "text", tiers.text)
  // Agent Duel saves reasoning without its metadata (`arena/privacy.ts`), so a fork never copies a
  // signature. One that does carry metadata is signed or encrypted with its text and stays as is.
  if (part.type === "reasoning") return hasEntries(part.metadata) ? part : withField(part, "text", tiers.text)
  if (part.type === "tool") return retargetTool(part, tiers)
  return part
}

function withField(part: Record<string, unknown>, key: string, rewrite: Rewrite) {
  const value = part[key]
  if (typeof value !== "string") return part
  const next = rewrite(value)
  return next === value ? part : { ...part, [key]: next }
}

// Tools whose output is a page from elsewhere: it names ports of machines that are not this one.
const EXTERNAL_OUTPUT = new Set(["websearch", "codesearch"])

function retargetTool(part: Record<string, unknown>, tiers: Tiers) {
  const state = part.state
  if (!plainObject(state)) return part
  const tool = typeof part.tool === "string" ? part.tool : ""
  const input = plainObject(state.input) ? state.input : undefined
  const next: Record<string, unknown> = {}
  if (input) {
    const rewritten = retargetInput(tool, input, tiers.tool)
    if (rewritten !== input) next.input = rewritten
  }
  if (typeof state.output === "string") {
    const rewritten = retargetOutput(tool, input ?? {}, state.output, tiers)
    if (rewritten !== state.output) next.output = rewritten
  }
  if (typeof state.error === "string") {
    const rewritten = tiers.tool(state.error)
    if (rewritten !== state.error) next.error = rewritten
  }
  if (Object.keys(next).length === 0) return part
  return { ...part, state: { ...state, ...next } }
}

function retargetInput(tool: string, input: Record<string, unknown>, rewrite: Rewrite) {
  const file = filePath(input)
  const log = file !== undefined && logFile(file)
  if (tool === "write") return mapLeaves(input, rewrite, log ? [] : ["content"])
  if (tool === "edit") return mapLeaves(input, rewrite, log ? [] : ["oldString", "newString"])
  if (tool === "multiedit") return mapLeaves(input, rewrite, log ? [] : ["edits"])
  if (tool === "apply_patch" && typeof input.patchText === "string") {
    const patchText = retargetPatch(input.patchText, rewrite)
    return mapLeaves(patchText === input.patchText ? input : { ...input, patchText }, rewrite, ["patchText"])
  }
  if (tool === "bash" && typeof input.command === "string") {
    const command = rewrite(input.command, fileWrites(input.command))
    return mapLeaves(command === input.command ? input : { ...input, command }, rewrite, ["command"])
  }
  return mapLeaves(input, rewrite, [])
}

function retargetOutput(tool: string, input: Record<string, unknown>, output: string, tiers: Tiers) {
  if (EXTERNAL_OUTPUT.has(tool)) return output
  // A subagent's answer is prose, as the parent's own answer is.
  if (tool === "task") return tiers.text(output)
  if (tool === "read") {
    const file = filePath(input)
    return file !== undefined && logFile(file) ? tiers.tool(output) : output
  }
  if (tool === "grep") return retargetGrep(output, tiers.tool)
  if (tool === "bash" && typeof input.command === "string" && readsFiles(input.command)) return output
  return tiers.tool(output)
}

function filePath(input: Record<string, unknown>) {
  const value = input.filePath ?? input.file_path ?? input.path
  return typeof value === "string" ? value : undefined
}

/** Rewrites every string under `value` except the top-level keys in `keep`. */
function mapLeaves(value: Record<string, unknown>, rewrite: Rewrite, keep: readonly string[]) {
  let changed = false
  const entries = Object.entries(value).map(([key, entry]) => {
    if (keep.includes(key)) return [key, entry] as const
    const next = mapValue(entry, rewrite)
    if (next !== entry) changed = true
    return [key, next] as const
  })
  return changed ? Object.fromEntries(entries) : value
}

function mapValue(value: unknown, rewrite: Rewrite): unknown {
  if (typeof value === "string") return rewrite(value)
  if (Array.isArray(value)) {
    const next = value.map((entry) => mapValue(entry, rewrite))
    return next.some((entry, index) => entry !== value[index]) ? next : value
  }
  if (plainObject(value)) return mapLeaves(value, rewrite, [])
  return value
}

const JSON_FILE = /\.(?:json|jsonc|json5|jsonl|ndjson|geojson|har)$/i

/**
 * A log is what a program printed while it ran, so its ports are as stale as a command's output.
 * Every other file is content the agent or the project wrote, and a later edit must still match it.
 */
export function logFile(file: string) {
  if (JSON_FILE.test(file)) return false
  const segments = file.split(/[\\/]/)
  const name = segments.at(-1) ?? ""
  if (/\.(?:log|out|err)$/i.test(name) || name === "nohup.out") return true
  return segments.slice(0, -1).some((segment) => segment === "log" || segment === "logs")
}

// `*** Update File: path` sections; only a log's section is rewritten.
function retargetPatch(patch: string, rewrite: Rewrite) {
  const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
  const keep: Range[] = []
  const sections = [...patch.matchAll(header)]
  sections.forEach((match, index) => {
    const start = match.index
    const end = sections[index + 1]?.index ?? patch.length
    if (!logFile(match[1]!.trim())) keep.push([start, end])
  })
  if (sections.length === 0) return patch
  return rewrite(patch, keep)
}

// The grep tool prints `path:` and then `  Line N: text` for each match in that file.
function retargetGrep(output: string, rewrite: Rewrite) {
  let file: string | undefined
  const lines = output.split("\n")
  const next = lines.map((line) => {
    if (line.length > 1 && !/^\s/.test(line) && line.endsWith(":")) {
      file = line.slice(0, -1)
      return line
    }
    if (/^\s+Line \d+:/.test(line) && file !== undefined && logFile(file)) return rewrite(line)
    return line
  })
  return next.some((line, index) => line !== lines[index]) ? next.join("\n") : output
}

function rewriters(bank: ArenaEnvironmentBank, env: Env): Tiers | undefined {
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
  const rewrite =
    (numbers: (value: string) => Match[]): Rewrite =>
    (value, keep = []) => {
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
          if (replacement !== undefined)
            found.push({ start: match.index, end: match.index + match[0].length, replacement })
        }
      }
      found.push(...numbers(value))
      if (found.length === 0) return value
      return apply(value, found, [...keep, ...protectedRanges(value)])
    }
  return {
    text: rewrite((value) => textPorts(value, ports)),
    tool: rewrite((value) => contextPorts(value, ports)),
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
 * Text: any number equal to a port, unless it is part of a name: glued to a letter, digit or
 * underscore (`ord_ab51101`), a dashed name (`req-51101-ab12`, `web-51101.txt`), a version or file
 * extension (`1.51101.0`, `51101.txt`), or a path segment (`/proc/51101`). A slash between two
 * numbers is a list (`51101/51102/51103`), whose values all change together.
 */
function textPorts(value: string, ports: ReadonlyMap<string, string>): Match[] {
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

// Tool calls: a number only where a port belongs.
const PORT_CONTEXTS = [
  // localhost:N, http://127.0.0.1:N/path, 0.0.0.0:N, [::1]:N, [::]:N, name.localhost:N, *:N
  String.raw`(?<![\w.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::ffff:127\.0\.0\.1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost):`,
  String.raw`(?<![\w.*-])\*:`,
  // --port N, --port=N, --dev-port N, PORT=N, VITE_PORT="N", server.port=N, port N, Port: N,
  // "port": N. Not "ports: N, M": a list with one value changed names two banks.
  String.raw`(?<![\w.])(?:[a-z0-9_.-]*[_.-])?port\d*["']?[ \t]*[:=]?[ \t]*["']?`,
  // -p N (docker -p N:M changes only the host side), --listen N
  String.raw`(?<![\w-])(?:-p|--listen)(?:=|[ \t]+)`,
  // lsof -i :N, lsof -iTCP:N, lsof -ti:N
  String.raw`(?<![\w-])-[a-z]*i[46]?(?:tcp|udp)?[ \t]*:`,
  // nc -z localhost N, telnet 127.0.0.1 N
  String.raw`(?<![\w-])(?:nc|ncat|netcat|telnet)(?:[ \t]+-[a-z]+)*[ \t]+[^\s;|&]+[ \t]+`,
  // python3 -m http.server N
  String.raw`(?<![\w-])(?:http\.server|SimpleHTTPServer)(?:[ \t]+(?:--bind|-b|--directory|-d)[ \t]+\S+)*[ \t]+`,
  // Listening on N, serving on :N, running at port N
  String.raw`(?<!\w)(?:listening|listens|listen|serving|running|bound|started)[ \t]+(?:on|at|to)[ \t]+(?:port[ \t]+)?:?`,
  // grep :N, addr=":N"
  String.raw`(?<![^\s"'=(\[,]):`,
]
const PORT_CONTEXT = new RegExp(String.raw`(?:${PORT_CONTEXTS.join("|")})(\d{1,5})(?![\w]|\.\d)`, "gi")
// fuser -k N/tcp
const PORT_SUFFIX = /(?<![\w.-])(\d{1,5})\/(?:tcp|udp)\b/gi

function contextPorts(value: string, ports: ReadonlyMap<string, string>): Match[] {
  return [...value.matchAll(PORT_CONTEXT), ...value.matchAll(PORT_SUFFIX)].flatMap((match) => {
    const number = match[1]!
    const replacement = ports.get(number)
    if (replacement === undefined) return []
    const start = match[0] === number ? match.index : match.index + match[0].lastIndexOf(number)
    return [{ start, end: start + number.length, replacement }]
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
  ranges.push(...jsonRanges(value))
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
 * JSON documents inside a string: the whole string, or any `{"…` / `[…` span that parses. JSON is
 * data a program wrote or reads (a config, an API response), never rewritten.
 */
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

type Word = { readonly text: string; readonly start: number; readonly end: number }
type Command = { readonly words: Word[]; readonly heredocs: Range[] }
type Pipeline = { readonly commands: Command[]; readonly start: number; readonly end: number }

/**
 * A small POSIX shell reader: pipelines, their commands, unquoted words and here-document bodies.
 * It only has to find which files a command reads or writes, so it does not expand anything.
 */
function parseShell(source: string): Pipeline[] {
  const pipelines: Pipeline[] = []
  let commands: Command[] = []
  let words: Word[] = []
  let heredocs: Range[] = []
  let word: { text: string; start: number } | undefined
  let pipelineStart = 0
  const pending: { delimiter: string; strip: boolean; into: Range[] }[] = []
  const append = (text: string, at: number) => {
    if (word) word.text += text
    else word = { text, start: at }
  }
  const endWord = (at: number) => {
    if (word) words.push({ ...word, end: at })
    word = undefined
  }
  const endCommand = (at: number) => {
    endWord(at)
    if (words.length > 0) commands.push({ words, heredocs })
    words = []
    heredocs = []
  }
  const endPipeline = (at: number) => {
    endCommand(at)
    if (commands.length > 0) pipelines.push({ commands, start: pipelineStart, end: at })
    commands = []
    pipelineStart = at + 1
  }
  const readHeredocs = (from: number) => {
    let cursor = from
    for (const heredoc of pending.splice(0)) {
      const bodyStart = cursor
      let bodyEnd = source.length
      while (cursor < source.length) {
        const newline = source.indexOf("\n", cursor)
        const lineEnd = newline === -1 ? source.length : newline
        const line = source.slice(cursor, lineEnd)
        if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
          bodyEnd = cursor
          cursor = lineEnd + 1
          break
        }
        cursor = lineEnd + 1
      }
      heredoc.into.push([bodyStart, Math.min(bodyEnd, source.length)])
    }
    return cursor
  }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "\\") {
      if (source[index + 1] !== "\n") append(source[index + 1] ?? "", index)
      index++
      continue
    }
    if (character === "'") {
      const close = source.indexOf("'", index + 1)
      const end = close === -1 ? source.length : close
      append(source.slice(index + 1, end), index)
      index = end
      continue
    }
    if (character === '"') {
      let text = ""
      let cursor = index + 1
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === "\\" && cursor + 1 < source.length) cursor++
        text += source[cursor]
        cursor++
      }
      append(text, index)
      index = cursor
      continue
    }
    if (character === "#" && !word) {
      const newline = source.indexOf("\n", index)
      index = (newline === -1 ? source.length : newline) - 1
      continue
    }
    if (character === " " || character === "\t") {
      endWord(index)
      continue
    }
    if (character === "\n") {
      endPipeline(index)
      if (pending.length > 0) {
        index = readHeredocs(index + 1) - 1
        pipelineStart = index + 1
      }
      continue
    }
    if (character === "&" && (word?.text.endsWith(">") || source[index + 1] === ">")) {
      append(character, index)
      continue
    }
    if (character === ";" || character === "&" || character === "(" || character === ")" || character === "`") {
      if (source[index + 1] === character && character !== "(" && character !== ")") index++
      endPipeline(index)
      continue
    }
    if (character === "|") {
      if (source[index + 1] === "|") {
        index++
        endPipeline(index)
      } else endCommand(index)
      continue
    }
    if (character === "<" && source[index + 1] === "<" && source[index + 2] !== "<") {
      const heredoc = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/.exec(source.slice(index))
      if (heredoc) {
        endWord(index)
        pending.push({
          delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? "",
          strip: heredoc[1] === "-",
          into: heredocs,
        })
        words.push({ text: "<<", start: index, end: index + heredoc[0].length })
        index += heredoc[0].length - 1
        continue
      }
    }
    append(character, index)
  }
  endPipeline(source.length)
  return pipelines
}

const COMMAND_PREFIXES = new Set(["sudo", "nohup", "time", "env", "exec", "command", "builtin", "nice", "stdbuf"])

function commandWords(command: Command) {
  // Redirections and their targets are not arguments: `cat > config.json` reads nothing.
  const words = command.words.filter(
    (word, index) => !redirect(word.text) && !/^(?:\d*|&)(?:>>?|<|>\|)$/.test(command.words[index - 1]?.text ?? ""),
  )
  let index = 0
  while (
    index < words.length &&
    (COMMAND_PREFIXES.has(words[index]!.text) || /^[A-Za-z_]\w*=/.test(words[index]!.text))
  ) {
    index++
  }
  const name = words[index]?.text.split("/").at(-1) ?? ""
  return { name, args: words.slice(index + 1).map((word) => word.text) }
}

// `>`, `>>`, `2>&1`, `>file`, `&>file`, `<file`, `<<`
function redirect(text: string) {
  return /^(?:\d*|&)(?:>>?|<<?|>\|)/.test(text)
}

// Where the command sends its standard output, from `> file`, `>> file`, `&> file`, `1> file`.
function stdoutTargets(command: Command) {
  return command.words.flatMap((word, index) => {
    const match = /^(?:1|&)?>>?\|?(.*)$/.exec(word.text)
    if (!match) return []
    const target = match[1] || command.words[index + 1]?.text
    if (!target || target.startsWith("&")) return []
    return [target]
  })
}

function projectFile(file: string) {
  return !file.startsWith("/dev/") && !logFile(file)
}

const CONTENT_WRITERS = new Set(["echo", "printf", "cat"])

/**
 * Pipelines that write file content: `cat > file <<EOF`, `echo … > file`, `… | tee file`,
 * `sed -i …`. Their text is the file's content, kept as written like a `write` call's.
 */
function fileWrites(command: string): Range[] {
  return parseShell(command).flatMap((pipeline) => {
    const writes = pipeline.commands.some((item) => {
      const { name, args } = commandWords(item)
      const operands = args.filter((arg) => !arg.startsWith("-"))
      if (name === "tee") return operands.some(projectFile)
      if ((name === "sed" || name === "perl") && args.some((arg) => /^-\w*i/.test(arg) || arg === "--in-place")) {
        return operands.slice(1).some(projectFile) || operands.length <= 1
      }
      const targets = stdoutTargets(item).filter(projectFile)
      if (targets.length === 0) return false
      return CONTENT_WRITERS.has(name) || item.heredocs.length > 0
    })
    if (!writes) return []
    return [[pipeline.start, pipeline.end] as Range, ...pipeline.commands.flatMap((item) => item.heredocs)]
  })
}

const FILE_READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "tac", "diff"])
const PATTERN_READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk"])
// Options of the readers above that take the next word as their value.
const SEARCH_OPTIONS = ["-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "--max-count", "--glob", "--type"]
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  head: ["-n", "-c", "--lines", "--bytes"],
  tail: ["-n", "-c", "--lines", "--bytes"],
  grep: SEARCH_OPTIONS,
  egrep: SEARCH_OPTIONS,
  fgrep: SEARCH_OPTIONS,
  rg: SEARCH_OPTIONS,
  ag: SEARCH_OPTIONS,
  sed: ["-e", "-f"],
  awk: ["-f", "-v", "-F"],
}

/** Whether a shell command prints a file that is not a log: `cat config.json`, `grep x src/a.ts`. */
function readsFiles(command: string) {
  return parseShell(command).some((pipeline) =>
    pipeline.commands.some((item, position) => {
      const { name, args } = commandWords(item)
      if (name === "git") return args[0] === "diff" || args[0] === "show"
      if (!FILE_READERS.has(name) && !PATTERN_READERS.has(name)) return false
      const operands: string[] = []
      let pattern = PATTERN_READERS.has(name) && !args.some((arg) => arg === "-e" || arg === "-f")
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (VALUE_OPTIONS[name]?.includes(arg)) {
          index++
          continue
        }
        if (arg.startsWith("-") || /^\d+$/.test(arg)) continue
        if (pattern) {
          pattern = false
          continue
        }
        operands.push(arg)
      }
      if (operands.length > 0) return operands.some(projectFile)
      // `rg x` and `grep -r x` search the working directory; anything else reads its input.
      return position === 0 && (name === "rg" || name === "ag" || args.some((arg) => /^-\w*[rR]/.test(arg)))
    }),
  )
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
