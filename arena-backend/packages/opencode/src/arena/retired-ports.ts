import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { callerRoots } from "./caller-roots"
import { hostnameForAlias, PORT_ALIASES, type PortAlias, type PortAliases } from "./preview"
import { serviceOwnerID } from "./services"

/**
 * A contestant's history is the earlier winners' transcripts, byte for byte, so it shows their
 * literal ports. Those ports are never handed out again (`PORT_RANGE` in `preview.ts`), and once a
 * winner is released the engine listens on them itself: a connection from a current contestant's
 * process reaches that contestant's port with the same alias, and anything else is told the port
 * belonged to an earlier turn.
 */
export type RetiredPort = { readonly port: number; readonly alias: PortAlias; readonly turnIndex: number }

export type Contestant = {
  readonly directory: string
  readonly hostname: string
  readonly portAliases: PortAliases
}

export type CallerConnection = {
  readonly localAddress?: string
  readonly localPort?: number
  readonly remoteAddress?: string
  readonly remotePort?: number
}

/** Which evidence named the caller's contestant: a recorded root, a process environment, or a cwd. */
export type CallerMethod = "root" | "env" | "cwd"

export type Identified = { readonly contestant: Contestant; readonly method: CallerMethod; readonly pid?: number }

export type CallerIdentifier = (
  connection: CallerConnection,
  contestants: readonly Contestant[],
) => Promise<Identified | undefined>

/** What happened to one connection to a retired port, for the engine log. */
export type RetiredPortOutcome =
  | {
      readonly kind: "forwarded"
      readonly method: CallerMethod | "referer"
      readonly target: number
      readonly pid?: number
    }
  | { readonly kind: "gone"; readonly pid?: number }
  | { readonly kind: "closed" }
  | { readonly kind: "unreachable"; readonly method: CallerMethod | "referer"; readonly target: number }

export type ChatPorts = {
  readonly ports: readonly RetiredPort[]
  /** The chat's contestants that own a live environment now; read on every connection. */
  readonly contestants: () => Promise<readonly Contestant[]>
}

const SNIFF_TIMEOUT_MS = 2_000
const MAX_HEAD_BYTES = 16 * 1024
const MAX_BUFFERED_BYTES = 1024 * 1024
const IDENTITY_TTL_MS = 5_000
const MAX_CHAIN = 64

function command(file: string, args: readonly string[]) {
  return new Promise<string>((resolve) => {
    execFile(
      file,
      [...args],
      { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
      (_error, stdout) => resolve(stdout),
    )
  })
}

/**
 * The PID that owns the client end of a loopback connection, from macOS `netstat -anv`, whose
 * rows end in `process:pid` (about 20 ms; lsof takes about 180 ms). A name can hold spaces.
 */
export function parseNetstatOwner(output: string, connection: CallerConnection): number | undefined {
  if (!connection.remotePort || !connection.localPort) return
  const client = `.${connection.remotePort}`
  const server = `.${connection.localPort}`
  for (const line of output.split("\n")) {
    const row = line.match(/^tcp\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+\S+\s+\d+\s+\d+\s+\d+\s+\d+\s+(.*?):(\d+)(?:\s|$)/)
    if (!row) continue
    if (!row[1].endsWith(client) || !row[2].endsWith(server)) continue
    const pid = Number(row[4])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) return pid
  }
}

async function callerPid(connection: CallerConnection) {
  if (process.platform === "darwin") {
    const pid = parseNetstatOwner(await command("netstat", ["-anv", "-p", "tcp"]), connection)
    if (pid) return pid
  }
  if (!connection.remotePort || !connection.remoteAddress) return
  const address = connection.remoteAddress.includes(":") ? `[${connection.remoteAddress}]` : connection.remoteAddress
  const output = await command("lsof", ["-nP", `-iTCP@${address}:${connection.remotePort}`, "-Fp"])
  for (const line of output.split("\n")) {
    const pid = Number(line.slice(1))
    if (line.startsWith("p") && Number.isInteger(pid) && pid > 0 && pid !== process.pid) return pid
  }
}

export function parseProcessParents(output: string) {
  const parents = new Map<number, number>()
  for (const line of output.split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (row) parents.set(Number(row[1]), Number(row[2]))
  }
  return parents
}

/** The caller and its ancestors, nearest first, up to the engine or init. */
export function processChain(pid: number, parents: ReadonlyMap<number, number>, stopAt = process.pid) {
  const chain: number[] = []
  let current: number | undefined = pid
  while (current && current > 1 && current !== stopAt && chain.length < MAX_CHAIN && !chain.includes(current)) {
    chain.push(current)
    current = parents.get(current)
  }
  return chain
}

/** `ps eww` lines; a platform binary (/bin/zsh, /usr/bin/curl) shows its command without environment. */
export function parseProcessEnvironments(output: string) {
  const environments = new Map<number, string>()
  for (const line of output.split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(.*)$/)
    if (row) environments.set(Number(row[1]), row[2])
  }
  return environments
}

export function parseProcessCwds(output: string) {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

function inside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export type CallerFacts = {
  readonly chain: readonly number[]
  readonly roots?: ReadonlyMap<number, string>
  readonly environments?: ReadonlyMap<number, string>
  readonly cwds?: ReadonlyMap<number, string>
}

/**
 * The contestant a caller belongs to, nearest ancestor first within each kind of evidence: a root
 * the engine started for the contestant, then the owner ID or port the engine put in a process's
 * environment, then a working directory inside the contestant's worktree.
 */
export function matchCaller(facts: CallerFacts, contestants: readonly Contestant[]): Contestant | undefined {
  const byOwner = new Map(contestants.map((contestant) => [serviceOwnerID(contestant.directory), contestant]))
  for (const pid of facts.chain) {
    const owner = facts.roots?.get(pid)
    if (owner && byOwner.has(owner)) return byOwner.get(owner)
  }
  for (const pid of facts.chain) {
    const environment = facts.environments?.get(pid)
    if (!environment) continue
    const owner = environment.match(/(?:^|\s)PASEO_ARENA_OWNER_ID=([a-f0-9]{64})(?:\s|$)/)?.[1]
    if (owner && byOwner.has(owner)) return byOwner.get(owner)
    const port = Number(environment.match(/(?:^|\s)PASEO_PORT=(\d+)(?:\s|$)/)?.[1])
    const found = port ? contestants.find((contestant) => contestant.portAliases.PASEO_PORT === port) : undefined
    if (found) return found
  }
  for (const pid of facts.chain) {
    const cwd = facts.cwds?.get(pid)
    const found = cwd ? contestants.find((contestant) => inside(contestant.directory, cwd)) : undefined
    if (found) return found
  }
}

/** Identify a caller from the live process table, cheapest evidence first, cached by PID. */
export function createProcessIdentifier(): CallerIdentifier {
  const cache = new Map<number, { readonly owner?: string; readonly method?: CallerMethod; readonly at: number }>()
  return async (connection, contestants) => {
    const pid = await callerPid(connection)
    if (!pid) return
    const cached = cache.get(pid)
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
      const contestant = contestants.find((candidate) => serviceOwnerID(candidate.directory) === cached.owner)
      return contestant && cached.method ? { contestant, method: cached.method, pid } : undefined
    }
    const remember = (contestant: Contestant | undefined, method: CallerMethod) => {
      for (const [key, entry] of cache) if (Date.now() - entry.at >= IDENTITY_TTL_MS) cache.delete(key)
      cache.set(
        pid,
        contestant ? { owner: serviceOwnerID(contestant.directory), method, at: Date.now() } : { at: Date.now() },
      )
      return contestant ? { contestant, method, pid } : undefined
    }
    const chain = processChain(pid, parseProcessParents(await command("ps", ["-A", "-o", "pid=,ppid="])))
    if (chain.length === 0) return remember(undefined, "root")
    const byRoot = matchCaller({ chain, roots: callerRoots() }, contestants)
    if (byRoot) return remember(byRoot, "root")
    const list = chain.join(",")
    const byEnvironment = matchCaller({ chain, environments: await environmentsOf(chain, list) }, contestants)
    if (byEnvironment) return remember(byEnvironment, "env")
    const cwds = parseProcessCwds(await command("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", list]))
    return remember(matchCaller({ chain, cwds }, contestants), "cwd")
  }
}

async function environmentsOf(chain: readonly number[], list: string) {
  if (process.platform !== "linux")
    return parseProcessEnvironments(await command("ps", ["eww", "-o", "pid=,command=", "-p", list]))
  const entries = await Promise.all(
    chain.map(async (pid) => {
      const raw = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")
      return [pid, raw.split("\0").join(" ")] as const
    }),
  )
  return new Map(entries.filter(([, value]) => value))
}

type HttpHead =
  | { readonly kind: "incomplete" }
  | { readonly kind: "other" }
  | { readonly kind: "http"; readonly headers: Readonly<Record<string, string>> }

export function parseHttpHead(data: Buffer): HttpHead {
  const text = data.subarray(0, MAX_HEAD_BYTES).toString("latin1")
  const start = text.slice(0, 16)
  if (start.length > 0 && !/^[A-Z]{1,15}( |$)/.test(start)) return { kind: "other" }
  const end = text.indexOf("\r\n\r\n")
  if (end === -1) return data.length >= MAX_HEAD_BYTES ? { kind: "other" } : { kind: "incomplete" }
  const [requestLine, ...lines] = text.slice(0, end).split("\r\n")
  if (!/^[A-Z]+ \S+ HTTP\/\d(\.\d)?$/.test(requestLine ?? "")) return { kind: "other" }
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { kind: "http", headers }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/**
 * A page a contestant opened on its own preview that links to an old port: the browser is not
 * traceable to the contestant, but its Referer or Origin names the contestant's current port or
 * preview hostname.
 */
export function referrerContestant(
  headers: Readonly<Record<string, string>>,
  contestants: readonly Contestant[],
): Contestant | undefined {
  for (const value of [headers["referer"], headers["origin"]]) {
    if (!value) continue
    let url: URL
    try {
      url = new URL(value)
    } catch {
      continue
    }
    const host = url.hostname.toLowerCase()
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    const found = contestants.find((contestant) =>
      LOOPBACK_HOSTS.has(host)
        ? Object.values(contestant.portAliases).includes(port)
        : PORT_ALIASES.some((alias) => hostnameForAlias(contestant.hostname, alias).toLowerCase() === host),
    )
    if (found) return found
  }
}

function previewVariable(alias: PortAlias) {
  return alias === "PASEO_PORT" ? "ARENA_PREVIEW_URL" : `ARENA_PREVIEW_URL${alias.slice("PASEO_PORT".length)}`
}

export function retiredPortResponse(retired: RetiredPort) {
  const body =
    `Port ${retired.port} was ${retired.alias} of turn ${retired.turnIndex + 1}, an earlier battle turn. ` +
    `That server has stopped, and Agent Duel could not trace this request to a current contestant. ` +
    `Use the port in $${retired.alias} or the URL in $${previewVariable(retired.alias)} from your current environment.\n`
  return (
    "HTTP/1.1 410 Gone\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Cache-Control: no-store\r\n" +
    "Connection: close\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}

/** The answer to an HTTP caller whose own port with the same alias has no server yet. */
export function unreachableResponse(retired: RetiredPort, target: number) {
  const body =
    `Port ${retired.port} was ${retired.alias} of turn ${retired.turnIndex + 1}, an earlier battle turn. ` +
    `Agent Duel holds it and forwards your connections to your own ${retired.alias}, ${target}, ` +
    `but nothing listens on ${target}. Start your server on ${target} (the value of $${retired.alias}); ` +
    `a server cannot bind ${retired.port}.\n`
  return (
    "HTTP/1.1 502 Bad Gateway\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Cache-Control: no-store\r\n" +
    "Connection: close\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}

function listen(port: number, host: string) {
  return new Promise<{ readonly server?: net.Server; readonly code?: string }>((resolve) => {
    const server = net.createServer({ allowHalfOpen: true })
    server.once("error", (error: NodeJS.ErrnoException) => resolve({ code: error.code ?? "EUNKNOWN" }))
    server.listen({ port, host, exclusive: true }, () => resolve({ server }))
  })
}

function connectUpstream(port: number) {
  const attempt = (host: string) =>
    new Promise<net.Socket | undefined>((resolve) => {
      const socket = net.connect({ port, host, allowHalfOpen: true })
      socket.once("connect", () => resolve(socket))
      socket.once("error", () => {
        socket.destroy()
        resolve(undefined)
      })
    })
  // Services are told to bind 127.0.0.1, but `localhost` on a recent Node binds ::1.
  return attempt("127.0.0.1").then((socket) => socket ?? attempt("::1"))
}

type Listening = { readonly retired: RetiredPort; readonly servers: readonly net.Server[] }
type ChatState = {
  contestants: ChatPorts["contestants"]
  readonly listening: Map<number, Listening>
  readonly sockets: Set<net.Socket>
}

export type RetiredPortForwarder = ReturnType<typeof createRetiredPortForwarder>

export function createRetiredPortForwarder(
  options: {
    readonly identify?: CallerIdentifier
    readonly sniffTimeoutMs?: number
    readonly log?: (message: string, data: Record<string, unknown>) => void
    readonly onConnection?: (retired: RetiredPort, outcome: RetiredPortOutcome) => void
  } = {},
) {
  const identify = options.identify ?? createProcessIdentifier()
  const sniffTimeoutMs = options.sniffTimeoutMs ?? SNIFF_TIMEOUT_MS
  const chats = new Map<string, ChatState>()
  const queues = new Map<string, Promise<unknown>>()

  const serialized = <A>(chatID: string, work: () => Promise<A>) => {
    const result = (queues.get(chatID) ?? Promise.resolve()).then(work, work)
    queues.set(
      chatID,
      result.catch(() => undefined),
    )
    return result
  }

  const track = (socket: net.Socket, chat: ChatState) => {
    chat.sockets.add(socket)
    socket.once("close", () => chat.sockets.delete(socket))
    socket.on("error", () => socket.destroy())
  }

  const handle = async (socket: net.Socket, retired: RetiredPort, chat: ChatState) => {
    track(socket, chat)
    const buffered: Buffer[] = []
    let size = 0
    let ended = false
    let wake: (() => void) | undefined
    const onData = (chunk: Buffer) => {
      buffered.push(chunk)
      size += chunk.length
      if (size > MAX_BUFFERED_BYTES) socket.pause()
      wake?.()
    }
    socket.on("data", onData)
    socket.once("end", () => {
      ended = true
      wake?.()
    })
    socket.once("close", () => wake?.())
    const connection: CallerConnection = {
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    }
    const contestants = await chat.contestants().catch(() => [] as readonly Contestant[])
    const identified = contestants.length ? await identify(connection, contestants).catch(() => undefined) : undefined
    let target = identified?.contestant
    let method: CallerMethod | "referer" | undefined = identified?.method
    const report = (outcome: RetiredPortOutcome) => {
      options.onConnection?.(retired, outcome)
      options.log?.("Arena retired-port connection", {
        port: retired.port,
        alias: retired.alias,
        turn: retired.turnIndex + 1,
        ...outcome,
      })
    }
    // Wait for the request head, so only an HTTP caller gets a text answer; anything else is closed.
    const sniff = async () => {
      const deadline = Date.now() + sniffTimeoutMs
      let head = parseHttpHead(Buffer.concat(buffered))
      while (head.kind === "incomplete" && !ended && !socket.destroyed && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = undefined
        head = parseHttpHead(Buffer.concat(buffered))
      }
      return head
    }
    if (!target) {
      const head = await sniff()
      if (head.kind !== "http") {
        report({ kind: "closed" })
        socket.destroy()
        return
      }
      target = referrerContestant(head.headers, contestants)
      method = "referer"
      if (!target) {
        report({ kind: "gone" })
        socket.end(retiredPortResponse(retired))
        return
      }
    }
    if (socket.destroyed) return
    const port = target.portAliases[retired.alias]
    const upstream = await connectUpstream(port)
    if (!upstream) {
      report({ kind: "unreachable", method: method ?? "referer", target: port })
      // An empty reply reads as "the server is down" with no reason; say where the port leads.
      if ((await sniff()).kind === "http" && !socket.destroyed) socket.end(unreachableResponse(retired, port))
      else socket.destroy()
      return
    }
    report({
      kind: "forwarded",
      method: method ?? "referer",
      target: port,
      ...(identified?.pid ? { pid: identified.pid } : {}),
    })
    track(upstream, chat)
    socket.off("data", onData)
    for (const chunk of buffered) upstream.write(chunk)
    upstream.on("close", () => socket.destroy())
    socket.on("close", () => upstream.destroy())
    if (ended) upstream.end()
    else socket.pipe(upstream)
    upstream.pipe(socket)
    socket.resume()
  }

  const bind = async (retired: RetiredPort, chat: ChatState) => {
    const v4 = await listen(retired.port, "127.0.0.1")
    if (!v4.server) return { code: v4.code }
    const v6 = await listen(retired.port, "::1")
    const servers = [v4.server, ...(v6.server ? [v6.server] : [])]
    for (const server of servers) {
      server.on("connection", (socket) => void handle(socket, retired, chat).catch(() => socket.destroy()))
    }
    return { listening: { retired, servers } satisfies Listening }
  }

  // Stops accepting at once; a connection already forwarded keeps running until its ends close.
  const closeServers = (listening: Listening) => {
    for (const server of listening.servers) server.close()
  }

  /** Listen on exactly these ports for the chat, keeping listeners it already has. */
  const sync = (chatID: string, input: ChatPorts) =>
    serialized(chatID, async () => {
      const chat = chats.get(chatID) ?? {
        contestants: input.contestants,
        listening: new Map<number, Listening>(),
        sockets: new Set<net.Socket>(),
      }
      chat.contestants = input.contestants
      chats.set(chatID, chat)
      const wanted = new Map(input.ports.map((retired) => [retired.port, retired]))
      for (const [port, listening] of chat.listening) {
        if (wanted.get(port)?.alias === listening.retired.alias) continue
        chat.listening.delete(port)
        closeServers(listening)
      }
      const failed: { port: number; code?: string }[] = []
      for (const retired of wanted.values()) {
        if (chat.listening.has(retired.port) || heldElsewhere(chatID, retired.port)) continue
        const bound = await bind(retired, chat)
        if (bound.listening) chat.listening.set(retired.port, bound.listening)
        else failed.push({ port: retired.port, ...(bound.code ? { code: bound.code } : {}) })
      }
      if (failed.length) options.log?.("Arena could not listen on retired ports", { chatID, failed })
      return { listening: [...chat.listening.keys()].sort((left, right) => left - right), failed }
    })

  const heldElsewhere = (chatID: string, port: number) =>
    [...chats].some(([id, chat]) => id !== chatID && chat.listening.has(port))

  /** Stop listening for a chat and drop its connections; its table stays in the store for the next sync. */
  const stop = (chatID: string) =>
    serialized(chatID, async () => {
      const chat = chats.get(chatID)
      if (!chat) return
      chats.delete(chatID)
      for (const listening of chat.listening.values()) closeServers(listening)
      for (const socket of chat.sockets) socket.destroy()
    })

  const close = async () => {
    await Promise.all([...chats.keys()].map(stop))
  }

  const holds = (port: number) => [...chats.values()].some((chat) => chat.listening.has(port))

  return { sync, stop, close, holds }
}

/**
 * `open` on the contestant's PATH. The user's browser is not a process the forwarder can trace to
 * a contestant, so a localhost URL from an earlier turn is retargeted to this contestant's own
 * port, and an old preview hostname to its own, before macOS opens it.
 */
export const OPEN_SHIM = `#!/bin/sh
# Agent Duel: retarget localhost URLs and preview hosts from earlier battle turns.
count=$#
index=0
while [ "$index" -lt "$count" ]; do
  argument=$1
  shift
  for pair in $ARENA_RETIRED_PORTS; do
    old=\${pair%%=*}
    new=\${pair#*=}
    argument=$(printf '%s' "$argument" | sed -E "s#(localhost|127\\.0\\.0\\.1|\\[::1\\]):$old([^0-9]|\\$)#\\1:$new\\2#g")
  done
  for pair in $ARENA_RETIRED_HOSTS; do
    old=\${pair%%=*}
    new=\${pair#*=}
    argument=$(printf '%s' "$argument" | sed "s#//$old#//$new#g")
  done
  set -- "$@" "$argument"
  index=$((index + 1))
done
exec "\${ARENA_OPEN_COMMAND:-/usr/bin/open}" "$@"
`

/** Write the shim once per process; the directory goes first on a contestant's PATH. */
export async function writeOpenShim(directory: string) {
  if (process.platform !== "darwin") return
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, "open")
  await writeFile(file, OPEN_SHIM)
  await chmod(file, 0o755)
  return directory
}

export * as ArenaRetiredPorts from "./retired-ports"
