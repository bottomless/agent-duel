import type { Store } from "./mongo"
import type { RunDocument } from "./records"
import { environment as previewEnvironment, hostname, hostnameForAlias, PORT_ALIASES, type PortAlias } from "./preview"

/**
 * The ports a contestant may bind and the ones it must not. Every turn gets a fresh port bank and
 * fresh preview hostnames, and the engine rewrites most of the winner's old ones in copied history to
 * the new side's. A literal from an earlier round still reaches a command through what the rewrite
 * keeps (user messages, file content, long JSON), and a server bound there is unreachable through
 * the preview. The shell refuses such a command with the current values.
 */
export type Environment = {
  readonly ports: Readonly<Partial<Record<PortAlias, number>>>
  readonly urls: Readonly<Partial<Record<PortAlias, string>>>
  /**
   * Ports of the chat's earlier rounds, either side, that a server listened on and the current bank
   * does not hold again.
   */
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
  const retiredPorts = retired(
    current,
    (await store.runsForChat(turn.chatID)).filter((other) => earlierIDs.has(other.turnID)),
  )
  const retiredHosts = new Set<string>()
  for (const other of earlier)
    for (const side of ["a", "b"] as const)
      for (const alias of PORT_ALIASES) retiredHosts.add(hostnameForAlias(hostname(turn.chatID, other.turnIndex, side), alias))
  return { ports: run.portAliases, urls, retiredPorts, retiredHosts }
}

/**
 * The bank ports of earlier runs that a server listened on, as recorded before the run's services
 * were stopped. A port the bank handed out but nothing used is a number like any other, and a
 * listener outside the bank is the project's own port (`vite`'s 5173, an e2e port) that the next
 * round runs again.
 */
export function retired(
  current: ReadonlySet<number>,
  runs: readonly {
    readonly portAliases?: RunDocument["portAliases"]
    readonly services?: readonly { readonly listeners: readonly { readonly port: number }[] }[]
  }[],
): ReadonlySet<number> {
  const ports = new Set<number>()
  for (const run of runs) {
    const bank = new Set(Object.values(run.portAliases ?? {}))
    for (const service of run.services ?? [])
      for (const listener of service.listeners)
        if (bank.has(listener.port) && !current.has(listener.port)) ports.add(listener.port)
  }
  return ports
}

const WORD = /[A-Za-z0-9_]/
const LETTER = /[A-Za-z_]/

/**
 * Every number in `value` that is one of `ports`, unless it is part of a name: glued to a letter,
 * digit or underscore, a dashed name (`req-51101-ab12`), a version or file extension (`1.51101.0`,
 * `51101.txt`), or a path segment (`/proc/51101`). Copied from the history retarget's
 * `standalonePorts` (`arena/port-retarget.ts`, not merged yet); keep the two identical.
 */
function standalonePorts(value: string, ports: ReadonlySet<number>): number[] {
  return [...value.matchAll(/\d+/g)].flatMap((match) => {
    const port = Number(match[0])
    if (!ports.has(port)) return []
    const start = match.index
    const end = start + match[0].length
    const before = value[start - 1] ?? ""
    const before2 = value[start - 2] ?? ""
    const after = value[end] ?? ""
    const after2 = value[end + 1] ?? ""
    if (WORD.test(before) || WORD.test(after) || (before === "/" && !/\d/.test(before2))) return []
    if ((before === "." && WORD.test(before2)) || (before === "-" && LETTER.test(before2))) return []
    if ((after === "." && WORD.test(after2)) || (after === "-" && LETTER.test(after2))) return []
    return [port]
  })
}

const HOSTS = /\b(?:port[23]--)?turn\d+-[ab]--[0-9a-f]+\.localhost\b/g

/**
 * The refusal for a command that names a retired port or a retired preview host, or undefined. Any
 * mention counts, not only a bind: `http.server N`, `php -S host:N`, `P=N; vite --port $P` and
 * `listen(N)` bind with no flag to recognize, and a read of a retired port reaches nothing.
 */
export function violation(environment: Environment, command: string): string | undefined {
  const current = PORT_ALIASES.flatMap((alias) =>
    environment.ports[alias] === undefined ? [] : [`${alias}=${environment.ports[alias]}`],
  ).join(", ")
  const previews = PORT_ALIASES.flatMap((alias) =>
    environment.urls[alias] === undefined ? [] : [`${URL_NAMES[alias]}=${environment.urls[alias]}`],
  ).join(", ")
  const [port] = standalonePorts(command, environment.retiredPorts)
  if (port !== undefined)
    return `Port ${port} belonged to an earlier round of this chat and is not routed anymore, so nothing bound there is reachable. This round's ports are ${current}${previews ? `, with preview URLs ${previews}` : ""}. Bind the server to $PASEO_PORT instead, or PASEO_PORT2 and PASEO_PORT3 for additional listeners.`
  for (const match of command.matchAll(HOSTS)) {
    const host = match[0]
    if (!environment.retiredHosts.has(host)) continue
    return `${host} was a preview hostname of an earlier round of this chat and routes nowhere now. This round's preview URLs are ${previews || "not available yet"}${current ? `, serving ${current}` : ""}.`
  }
  return undefined
}

export * as ArenaPorts from "./ports"
