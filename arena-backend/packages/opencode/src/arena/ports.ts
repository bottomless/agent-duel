import type { Store } from "./mongo"
import { environment as previewEnvironment, hostname, hostnameForAlias, PORT_ALIASES, type PortAlias } from "./preview"

/**
 * The ports a contestant may bind and the ones it must not. Every turn gets a fresh port bank and
 * fresh preview hostnames, and the engine rewrites the winner's old ones in copied history to the
 * new side's. A literal from an earlier round still reaches a command when the user types it, and a
 * server bound there is unreachable through the preview. The shell refuses such a command with the
 * current values, so the rule needs no sentence in the prompt.
 */
export type Environment = {
  readonly ports: Readonly<Partial<Record<PortAlias, number>>>
  readonly urls: Readonly<Partial<Record<PortAlias, string>>>
  /** Ports of the chat's earlier rounds, either side, that the current bank does not hold again. */
  readonly retiredPorts: ReadonlySet<number>
  /** Preview hostnames of the chat's earlier rounds, every alias, either side. */
  readonly retiredHosts: ReadonlySet<string>
}

const URL_NAMES: Readonly<Record<PortAlias, string>> = {
  PASEO_PORT: "ARENA_PREVIEW_URL",
  PASEO_PORT2: "ARENA_PREVIEW_URL2",
  PASEO_PORT3: "ARENA_PREVIEW_URL3",
}

/** The environment of the run that owns `sessionID`, a subagent's included, or undefined outside a run. */
export async function environment(
  store: Store,
  sessionID: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Environment | undefined> {
  const run = await store.runs.findOne({ $or: [{ rootSessionID: sessionID }, { descendantSessionIDs: sessionID }] })
  if (!run?.portAliases) return undefined
  const turn = await store.turn(run.turnID)
  if (!turn) return undefined
  const live = previewEnvironment(run.worktree, env)
  const urls = Object.fromEntries(
    PORT_ALIASES.flatMap((alias) => (live[URL_NAMES[alias]] ? [[alias, live[URL_NAMES[alias]]]] : [])),
  ) as Partial<Record<PortAlias, string>>
  const current = new Set(Object.values(run.portAliases))
  const earlier = (await store.turns.find({ chatID: turn.chatID }, { projection: { _id: 1, turnIndex: 1 } }).toArray())
    .filter((other) => other.turnIndex < turn.turnIndex)
  const earlierIDs = new Set(earlier.map((other) => other._id))
  const retiredPorts = new Set<number>()
  for (const other of await store.runsForChat(turn.chatID)) {
    if (!earlierIDs.has(other.turnID)) continue
    for (const port of Object.values(other.portAliases ?? {})) if (!current.has(port)) retiredPorts.add(port)
  }
  const retiredHosts = new Set<string>()
  for (const other of earlier)
    for (const side of ["a", "b"] as const)
      for (const alias of PORT_ALIASES) retiredHosts.add(hostnameForAlias(hostname(turn.chatID, other.turnIndex, side), alias))
  return { ports: run.portAliases, urls, retiredPorts, retiredHosts }
}

// A port a command binds a server to: `--port 5173`, `--port=5173`, `PORT=5173`, `E2E_PORT=5173`, `-p 5173`.
const BINDS = /(?:--port(?:=|\s+)|(?:^|[\s;&|(])[A-Z0-9_]*PORT=|(?:^|\s)-p\s+)["']?(\d{4,5})\b/g
const HOSTS = /\b(?:port[23]--)?turn\d+-[ab]--[0-9a-f]+\.localhost\b/g

/** The refusal for a command that binds a retired port or names a retired preview host, or undefined. */
export function violation(environment: Environment, command: string): string | undefined {
  const current = PORT_ALIASES.flatMap((alias) =>
    environment.ports[alias] === undefined ? [] : [`${alias}=${environment.ports[alias]}`],
  ).join(", ")
  const previews = PORT_ALIASES.flatMap((alias) =>
    environment.urls[alias] === undefined ? [] : [`${URL_NAMES[alias]}=${environment.urls[alias]}`],
  ).join(", ")
  for (const match of command.matchAll(BINDS)) {
    const port = Number(match[1])
    if (!environment.retiredPorts.has(port)) continue
    return `Port ${port} belonged to an earlier round of this chat and is not routed anymore, so nothing bound there is reachable. This round's ports are ${current}${previews ? `, with preview URLs ${previews}` : ""}. Bind the server to $PASEO_PORT instead, or PASEO_PORT2 and PASEO_PORT3 for additional listeners.`
  }
  for (const match of command.matchAll(HOSTS)) {
    const host = match[0]
    if (!environment.retiredHosts.has(host)) continue
    return `${host} was a preview hostname of an earlier round of this chat and routes nowhere now. This round's preview URLs are ${previews || "not available yet"}${current ? `, serving ${current}` : ""}.`
  }
  return undefined
}

export * as ArenaPorts from "./ports"
