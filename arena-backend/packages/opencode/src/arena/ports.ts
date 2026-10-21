import type { Side } from "./domain"
import type { Store } from "./mongo"
import {
  environment as previewEnvironment,
  hostname as previewHostname,
  hostnameForAlias,
  listening as portListening,
  PORT_ALIASES,
  url as previewUrl,
  type PortAlias,
} from "./preview"
import type { RunDocument, TurnDocument } from "./records"

/**
 * What a contestant's history says about ports. The winner of each earlier turn became the chat's
 * history, so its literal ports and preview URLs are in every later contestant's transcript, and
 * the transcript is never rewritten. This module answers which of those numbers are retired and
 * what replaced them. Only winners are read: a loser's ports never reached the history, and naming
 * them would tell a contestant about a run it cannot see.
 */

/** One environment's ports and preview URLs. `turn` counts from 1, as the UI does. */
export type Bank = {
  readonly turn: number
  /** The bank belongs to a chat this one was forked from, so its turn number is that chat's. */
  readonly forked?: boolean
  readonly ports: Readonly<Partial<Record<PortAlias, number>>>
  readonly urls: Readonly<Partial<Record<PortAlias, string>>>
}

/** Forks of forks are followed this far back; a longer chain is cut rather than walked. */
const FORK_DEPTH = 8

export type PortHistory = {
  readonly current: Bank
  /** Earlier winners, oldest first, without any port the current bank holds again. */
  readonly earlier: readonly Bank[]
}

export type Listening = (port: number) => Promise<boolean>

const URL_NAMES: Readonly<Record<PortAlias, string>> = {
  PASEO_PORT: "ARENA_PREVIEW_URL",
  PASEO_PORT2: "ARENA_PREVIEW_URL2",
  PASEO_PORT3: "ARENA_PREVIEW_URL3",
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"])

/** The ports history of the run that owns this session, or undefined outside a contestant run. */
export async function portHistory(
  store: Store,
  sessionID: string,
  env: Record<string, string | undefined> = process.env,
): Promise<PortHistory | undefined> {
  const run = await store.runs.findOne({ $or: [{ rootSessionID: sessionID }, { descendantSessionIDs: sessionID }] })
  if (!run?.portAliases) return undefined
  const turn = await store.turn(run.turnID)
  if (!turn) return undefined
  const live = previewEnvironment(run.worktree, env)
  const current = bank(turn, run, env, (alias) => live[URL_NAMES[alias]])
  const winners = (await store.turns.find({ chatID: turn.chatID }).toArray()).filter(
    (earlier) => earlier.turnIndex < turn.turnIndex && becameHistory(earlier),
  )
  const earlier = [...(await inheritedBanks(store, turn.chatID, env, 0)), ...(await winnerBanks(store, winners, env))]
  return { current, earlier: withoutCurrent(current, earlier) }
}

/**
 * Record a session forked through the Arena fork route, so a chat started in the copy can name
 * the ports its copied history holds. Upserts: a retried fork records the same thing again.
 */
export async function recordFork(
  store: Store,
  fork: { readonly sessionID: string; readonly sourceSessionID: string; readonly beforeMessageID?: string },
) {
  await store.sessionForks.replaceOne(
    { _id: fork.sessionID },
    {
      _id: fork.sessionID,
      sourceSessionID: fork.sourceSessionID,
      ...(fork.beforeMessageID ? { beforeMessageID: fork.beforeMessageID } : {}),
      createdAt: new Date(),
    },
    { upsert: true },
  )
}

async function winnerBanks(
  store: Store,
  winners: readonly TurnDocument[],
  env: Record<string, string | undefined>,
  forked = false,
) {
  const sorted = winners.toSorted((left, right) => left.turnIndex - right.turnIndex)
  const runIDs = sorted.map((earlier) => earlier.runIDs[earlier.appliedSide!])
  const runs = runIDs.length ? await store.runs.find({ _id: { $in: runIDs } }).toArray() : []
  const byID = new Map(runs.map((item) => [item._id, item]))
  return sorted.flatMap((winner) => {
    const winning = byID.get(winner.runIDs[winner.appliedSide!])
    return winning?.portAliases ? [{ ...bank(winner, winning, env), ...(forked ? { forked } : {}) }] : []
  })
}

/**
 * The winners a chat inherited by being started in a forked session, oldest first. A turn is
 * inherited when its user message sorts before the fork boundary; message IDs ascend with time,
 * and a turn grafted before the fork has its canonical user message before any later message.
 */
async function inheritedBanks(
  store: Store,
  chatID: string,
  env: Record<string, string | undefined>,
  depth: number,
): Promise<Bank[]> {
  if (depth >= FORK_DEPTH) return []
  const chat = await store.chats.findOne({ _id: chatID })
  const sessions = [chatSession(chatID), chat?.canonicalSessionID].filter((value) => value !== undefined)
  const fork = sessions.length ? await store.sessionForks.findOne({ _id: { $in: sessions } }) : undefined
  if (!fork) return []
  const source = await store.chats.findOne({
    $or: [{ _id: chatIDOf(fork.sourceSessionID) }, { canonicalSessionID: fork.sourceSessionID }],
  })
  if (!source) return []
  const winners = (await store.turns.find({ chatID: source._id }).toArray()).filter(
    (earlier) =>
      becameHistory(earlier) &&
      (!fork.beforeMessageID ||
        !earlier.canonicalUserMessageID ||
        earlier.canonicalUserMessageID < fork.beforeMessageID),
  )
  return [
    ...(await inheritedBanks(store, source._id, env, depth + 1)),
    ...(await winnerBanks(store, winners, env, true)),
  ]
}

// `chatID` in service.ts: a chat is named after the session it started in.
function chatIDOf(sessionID: string) {
  return `chat|${sessionID.length}:${sessionID}`
}

function chatSession(chatID: string) {
  return /^chat\|\d+:(.+)$/.exec(chatID)?.[1]
}

function turnName(item: Bank) {
  return item.forked ? `turn ${item.turn} of the chat this one was forked from` : `turn ${item.turn}`
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** The winner's transcript is in the chat only once the vote applied it. */
function becameHistory(turn: TurnDocument): turn is TurnDocument & { appliedSide: Side } {
  if (!turn.appliedSide) return false
  return turn.canonicalGraftedAt !== undefined || turn.state === "complete" || turn.state === "cleanup_pending"
}

function bank(
  turn: TurnDocument,
  run: RunDocument,
  env: Record<string, string | undefined>,
  live: (alias: PortAlias) => string | undefined = () => undefined,
): Bank {
  const stored = new Map(
    (run.services ?? []).flatMap((service) =>
      service.proxyRoutes.flatMap((route) => (route.alias && route.url ? [[route.alias, route.url] as const] : [])),
    ),
  )
  const host = previewHostname(turn.chatID, turn.turnIndex, run.side)
  const urls = Object.fromEntries(
    PORT_ALIASES.flatMap((alias) => {
      const value =
        live(alias) ??
        stored.get(alias) ??
        previewUrl({ hostname: hostnameForAlias(host, alias), port: run.portAliases?.[alias] ?? 0 }, env)
      return value ? [[alias, value]] : []
    }),
  )
  return { turn: turn.turnIndex + 1, ports: { ...run.portAliases }, urls }
}

/** After the range wraps, a current port can repeat an old one; the current meaning wins. */
function withoutCurrent(current: Bank, earlier: readonly Bank[]): Bank[] {
  const held = new Set(Object.values(current.ports))
  return earlier.map((item) => ({
    ...item,
    ports: Object.fromEntries(Object.entries(item.ports).filter(([, port]) => !held.has(port))),
  }))
}

function currentValue(history: PortHistory, alias: PortAlias) {
  const port = history.current.ports[alias]
  const url = history.current.urls[alias]
  return `Your ${alias} is ${port}${url ? ` and your ${URL_NAMES[alias]} is ${url}` : ""}.`
}

function hostOf(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** `ports` with no input: the current values with live status, then each earlier winner's. */
export async function describe(history: PortHistory, listening: Listening = portListening) {
  const lines = [`Your environment (turn ${history.current.turn}). Use these values:`]
  for (const alias of PORT_ALIASES) {
    const port = history.current.ports[alias]
    if (port === undefined) continue
    const url = history.current.urls[alias]
    const status = (await listening(port)) ? "listening" : "not listening"
    lines.push(
      `- ${alias}=${port}${alias === "PASEO_PORT" ? " (also PORT)" : ""}: ${status}.${url ? ` ${URL_NAMES[alias]}=${url}` : ""}`,
    )
  }
  const earlier = history.earlier.filter((item) => Object.keys(item.ports).length || Object.keys(item.urls).length)
  if (earlier.length === 0) {
    lines.push("", "No earlier turn in this chat's history used Arena ports.")
    return lines.join("\n")
  }
  lines.push(
    "",
    "Earlier turns in this chat's history. Their environments are closed. Each value is followed by the one that replaces it:",
  )
  for (const item of earlier) {
    const entries: string[] = []
    for (const alias of PORT_ALIASES) {
      const port = item.ports[alias]
      if (port !== undefined) {
        const answers = await listening(port)
        entries.push(
          `  - ${alias} ${port} -> ${history.current.ports[alias]}${answers ? " (another program answers on " + port + " now; it is not yours, do not use or stop it)" : " (closed)"}`,
        )
      }
      const url = item.urls[alias]
      if (url && history.current.urls[alias])
        entries.push(`  - ${URL_NAMES[alias]} ${url} -> ${history.current.urls[alias]}`)
    }
    if (entries.length) lines.push(`- ${capitalize(turnName(item))}:`, ...entries)
  }
  return lines.join("\n")
}

/** `ports` with a `port` input. */
export async function translatePort(history: PortHistory, port: number, listening: Listening = portListening) {
  const own = PORT_ALIASES.find((alias) => history.current.ports[alias] === port)
  if (own) {
    const url = history.current.urls[own]
    return `${port} is your ${own}${url ? ` (${URL_NAMES[own]}=${url})` : ""}. It is ${(await listening(port)) ? "listening" : "not listening"}.`
  }
  const matches = history.earlier.flatMap((item) =>
    PORT_ALIASES.flatMap((alias) => (item.ports[alias] === port ? [{ item, alias }] : [])),
  )
  if (matches.length === 0) return `${port} is not an Arena port of this chat. ${yourPorts(history)}`
  const answers = await listening(port)
  return matches
    .map(
      ({ item, alias }) =>
        `${port} was ${alias} in ${turnName(item)}. ${answers ? "Another program answers on it now; it is not yours, so do not use or stop it." : "It is closed."} ${currentValue(history, alias)}`,
    )
    .join("\n")
}

/** `ports` with a `url` input. A path and query carry over to the replacement. */
export async function translateUrl(history: PortHistory, value: string, listening: Listening = portListening) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `${value} is not a valid URL. Give a complete URL, such as http://localhost:3000/.`
  }
  const host = parsed.hostname.toLowerCase()
  const own = PORT_ALIASES.find((alias) => hostOf(history.current.urls[alias] ?? "") === host)
  if (own) {
    const port = history.current.ports[own]
    const status =
      port === undefined
        ? ""
        : ` Its port, ${own}=${port}, is ${(await listening(port)) ? "listening" : "not listening"}.`
    return `${value} is your ${URL_NAMES[own]}.${status}`
  }
  for (const item of history.earlier) {
    const alias = PORT_ALIASES.find((name) => hostOf(item.urls[name] ?? "") === host)
    if (!alias) continue
    const replacement = history.current.urls[alias]
    const moved = replacement ? withOrigin(parsed, replacement) : undefined
    return `${value} was ${URL_NAMES[alias]} in ${turnName(item)}. It is closed.${moved ? ` Use ${moved} instead.` : ""} ${currentValue(history, alias)}`
  }
  if (LOOPBACK_HOSTS.has(host) && parsed.port) {
    const port = Number(parsed.port)
    const answer = await translatePort(history, port, listening)
    const alias = history.earlier.flatMap((item) => PORT_ALIASES.filter((name) => item.ports[name] === port))[0]
    const replacement = alias ? history.current.ports[alias] : undefined
    if (replacement === undefined) return answer
    const moved = new URL(parsed.href)
    moved.port = String(replacement)
    return `${answer}\nUse ${moved.href} instead.`
  }
  return `${value} is not an Arena preview URL or port of this chat. ${yourPorts(history)}`
}

function withOrigin(source: URL, origin: string) {
  try {
    const target = new URL(origin)
    target.pathname = source.pathname
    target.search = source.search
    target.hash = source.hash
    return target.href
  } catch {
    return undefined
  }
}

function yourPorts(history: PortHistory) {
  const values = PORT_ALIASES.flatMap((alias) => {
    const port = history.current.ports[alias]
    return port === undefined ? [] : [`${alias}=${port}`]
  })
  return `Your ports are ${values.join(", ")}.`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The note appended to a `bash` or `webfetch` result whose input names a retired port or preview
 * host of this chat. The exact number with no letter, digit, or dot beside it is enough: a chance
 * match costs one line of output, a missed one costs a contestant a turn on a dead port.
 */
export function note(history: PortHistory, input: string): string | undefined {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const item of history.earlier) {
    for (const alias of PORT_ALIASES) {
      const url = item.urls[alias]
      const host = url ? hostOf(url) : undefined
      if (url && host && mentionsHost(input, host) && !seen.has(`url:${url}`)) {
        seen.add(`url:${url}`)
        const replacement = history.current.urls[alias]
        lines.push(
          `${url} was ${URL_NAMES[alias]} in ${turnName(item)}, whose environment is closed.${replacement ? ` Your ${URL_NAMES[alias]} is ${replacement}.` : ""}`,
        )
      }
      const port = item.ports[alias]
      if (port === undefined || seen.has(`port:${port}`)) continue
      if (!new RegExp(`(?<![\\w.])${port}(?!\\w)`).test(input)) continue
      seen.add(`port:${port}`)
      lines.push(
        `${port} was ${alias} in ${turnName(item)}, whose environment is closed. ${currentValue(history, alias)}`,
      )
    }
  }
  if (lines.length === 0) return undefined
  return [
    "[Arena] This input names a port or URL from an earlier turn.",
    ...lines,
    "Call `ports` for all current values.",
  ].join("\n")
}

// `turn1-a--x.localhost` is the end of `port2--turn1-a--x.localhost`, so a hostname character
// before the match makes it a different host.
function mentionsHost(input: string, host: string) {
  return new RegExp(`(?<![a-z0-9.-])${escapeRegExp(host)}(?![a-z0-9-])`, "i").test(input)
}

export * as ArenaPorts from "./ports"
