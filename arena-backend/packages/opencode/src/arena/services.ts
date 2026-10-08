import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import type { ArenaPortAlias, CapturedService } from "./records"

const PORT_ALIASES = ["PASEO_PORT", "PASEO_PORT2", "PASEO_PORT3"] as const
const MAX_COMMAND_BYTES = 512
const MAX_ARGUMENT_BYTES = 512
const MAX_ARGUMENTS = 128
export const SERVICE_OWNER_ENV = "PASEO_ARENA_OWNER_ID"
export const SERVICE_RELATIVE_CWD_ENV = "PASEO_ARENA_RELATIVE_CWD"

export function serviceOwnerID(worktree: string) {
  return createHash("sha256").update(path.resolve(worktree)).digest("hex")
}

export type ServiceListener = {
  readonly port: number
  readonly alias?: ArenaPortAlias
  readonly verifiedAt?: Date
}

export type ProcessSnapshot = {
  readonly pid: number
  readonly processGroupID?: number
  readonly cwd?: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly ownerID?: string
  readonly ownerRelativeCwd?: string
  /**
   * True for the first process of a terminal session: it holds a controlling terminal its
   * parent does not. That is an interactive shell — a contestant terminal, or the user's own
   * — and never a service the turn started, however deep in the worktree it stands.
   */
  readonly sessionShell?: boolean
  /** A stable process start token (for example, `ps lstart`) used to reject reused PIDs. */
  readonly processStartIdentity?: string
  readonly listeners?: readonly ServiceListener[]
}

export type ManagedTerminalSnapshot = {
  readonly id: string
  readonly cwd: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly ownerID?: string
  readonly ownerRelativeCwd?: string
  readonly processStartIdentity?: string
  readonly listeners?: readonly ServiceListener[]
}

export type ServiceProxyRoute = CapturedService["proxyRoutes"][number]

export type ServiceAdapter = {
  /** Return all candidates. The implementation must not filter by port. */
  readonly listProcesses?: () => Promise<readonly ProcessSnapshot[]> | readonly ProcessSnapshot[]
  readonly listTerminals?: () => Promise<readonly ManagedTerminalSnapshot[]> | readonly ManagedTerminalSnapshot[]
  readonly stopProcessGroup?: (
    processGroupID: number,
    signal: "SIGTERM" | "SIGKILL",
  ) => Promise<void> | void
  readonly stopTerminal?: (terminalID: string) => Promise<void> | void
  readonly processGroupAlive?: (processGroupID: number) => Promise<boolean> | boolean
  readonly terminalAlive?: (terminalID: string) => Promise<boolean> | boolean
  /** Re-scan listeners after stopping. A missing method means no listener data is available. */
  readonly listenersForProcessGroup?: (processGroupID: number) => Promise<readonly ServiceListener[]> | readonly ServiceListener[]
  readonly listenersForTerminal?: (terminalID: string) => Promise<readonly ServiceListener[]> | readonly ServiceListener[]
  readonly wait?: (milliseconds: number) => Promise<void> | void
  /** Refuse to signal groups shared with the daemon/test runner. */
  readonly isProtectedProcessGroup?: (processGroupID: number) => Promise<boolean> | boolean
}

export type CaptureServicesInput = {
  readonly worktree: string
  readonly adapter?: ServiceAdapter
  readonly processes?: readonly ProcessSnapshot[]
  readonly terminals?: readonly ManagedTerminalSnapshot[]
  readonly portAliases?: Partial<Record<ArenaPortAlias, number>>
  readonly proxyRoutes?: readonly ServiceProxyRoute[]
  readonly now?: Date
}

export type ServiceStopRecord = {
  readonly command: string
  readonly relativeCwd: string
  readonly status: "stopped" | "already_absent" | "failed"
  readonly verified: boolean
  readonly error?: string
  readonly captured: CapturedService
  readonly stoppedAt: Date
}

function bounded(value: string, limit: number) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  if (Buffer.byteLength(normalized) <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`
}

export function normalizeCommand(command: string) {
  return bounded(command, MAX_COMMAND_BYTES)
}

export function normalizeArguments(args: readonly string[] = []) {
  return args.slice(0, MAX_ARGUMENTS).map((arg) => bounded(arg, MAX_ARGUMENT_BYTES))
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function relativeCwd(root: string, cwd: string) {
  const relative = path.relative(root, path.resolve(cwd))
  return relative || "."
}

function safeOwnerRelativeCwd(value: string | undefined) {
  if (!value) return "."
  const normalized = value.replaceAll("\\", "/")
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return "."
  return normalized || "."
}

function relevantEnv(env: Readonly<Record<string, string | undefined>> | undefined) {
  if (!env) return {}
  const result: Record<string, string> = {}
  for (const key of Object.keys(env).sort()) {
    const value = env[key]
    if (value === undefined) continue
    // Keep the aliases and variables that can affect a listener. Do not persist the
    // complete contestant environment (which often contains tokens and absolute paths).
    if (!PORT_ALIASES.includes(key as ArenaPortAlias) && !/(?:PORT|HOST|URL)$/i.test(key)) continue
    result[key] = bounded(value, MAX_ARGUMENT_BYTES)
  }
  return result
}

function listenersFor(
  listeners: readonly ServiceListener[] | undefined,
  aliases: Partial<Record<ArenaPortAlias, number>> | undefined,
  now: Date,
) {
  const byPort = new Map<number, ArenaPortAlias>()
  for (const alias of PORT_ALIASES) {
    const port = aliases?.[alias]
    if (port !== undefined) byPort.set(port, alias)
  }
  return (listeners ?? [])
    .filter((listener) => Number.isInteger(listener.port) && listener.port > 0 && listener.port <= 65_535)
    .map((listener) => ({
      port: listener.port,
      ...(listener.alias || !byPort.has(listener.port) ? {} : { alias: byPort.get(listener.port) }),
      verifiedAt: listener.verifiedAt ?? now,
    }))
}

function routesFor(routes: readonly ServiceProxyRoute[] | undefined) {
  return (routes ?? []).map((route) => ({
    hostname: bounded(route.hostname, 255),
    ...(route.url ? { url: bounded(route.url, 1024) } : {}),
    active: route.active,
  }))
}

function processBelongsTo(root: string, process: Pick<ProcessSnapshot, "cwd" | "ownerID" | "processGroupID">) {
  if (process.processGroupID === undefined) return false
  return (
    (process.cwd !== undefined && inside(root, process.cwd)) ||
    process.ownerID === serviceOwnerID(root)
  )
}

function terminalBelongsTo(root: string, terminal: Pick<ManagedTerminalSnapshot, "cwd" | "ownerID" | "id">) {
  return Boolean(terminal.id) && (inside(root, terminal.cwd) || terminal.ownerID === serviceOwnerID(root))
}

function captureProcess(
  root: string,
  process: ProcessSnapshot,
  aliases: Partial<Record<ArenaPortAlias, number>> | undefined,
  routes: readonly ServiceProxyRoute[] | undefined,
  now: Date,
): CapturedService | undefined {
  if (!processBelongsTo(root, process)) return
  const cwdOwned = process.cwd !== undefined && inside(root, process.cwd)
  const expectedOwnerID = serviceOwnerID(root)
  const tokenOwned = process.ownerID === expectedOwnerID
  if (!cwdOwned && !tokenOwned) return
  const command = normalizeCommand(process.command)
  if (!command) return
  return {
    kind: "owned_process",
    command,
    args: normalizeArguments(process.args),
    env: relevantEnv(process.env),
    relativeCwd: cwdOwned ? relativeCwd(root, process.cwd!) : safeOwnerRelativeCwd(process.ownerRelativeCwd),
    ...(process.processGroupID === undefined ? {} : { processGroupID: process.processGroupID }),
    ...(tokenOwned ? { ownerID: expectedOwnerID } : {}),
    ...(process.processStartIdentity === undefined ? {} : { processStartIdentity: process.processStartIdentity }),
    listeners: listenersFor(process.listeners, aliases, now),
    proxyRoutes: routesFor(routes),
    capturedAt: now,
    verifiedAt: now,
  }
}

function captureTerminal(
  root: string,
  terminal: ManagedTerminalSnapshot,
  aliases: Partial<Record<ArenaPortAlias, number>> | undefined,
  routes: readonly ServiceProxyRoute[] | undefined,
  now: Date,
): CapturedService | undefined {
  const cwdOwned = inside(root, terminal.cwd)
  const expectedOwnerID = serviceOwnerID(root)
  const tokenOwned = terminal.ownerID === expectedOwnerID
  if (!terminalBelongsTo(root, terminal) || (!cwdOwned && !tokenOwned)) return
  const command = normalizeCommand(terminal.command)
  if (!command) return
  return {
    kind: "owned_process",
    command,
    args: normalizeArguments(terminal.args),
    env: relevantEnv(terminal.env),
    relativeCwd: cwdOwned ? relativeCwd(root, terminal.cwd) : safeOwnerRelativeCwd(terminal.ownerRelativeCwd),
    managedTerminalID: bounded(terminal.id, 256),
    ...(tokenOwned ? { ownerID: expectedOwnerID } : {}),
    ...(terminal.processStartIdentity === undefined ? {} : { processStartIdentity: terminal.processStartIdentity }),
    listeners: listenersFor(terminal.listeners, aliases, now),
    proxyRoutes: routesFor(routes),
    capturedAt: now,
    verifiedAt: now,
  }
}

async function resolved<A>(value: A | Promise<A>) {
  return await value
}

/** Capture process groups and managed terminals belonging to one worktree. */
export async function captureOwnedServices(input: CaptureServicesInput): Promise<readonly CapturedService[]> {
  const root = path.resolve(input.worktree)
  const adapter = input.adapter ?? defaultServiceAdapter
  const now = input.now ?? new Date()
  const processes = input.processes ?? (adapter.listProcesses ? await resolved(adapter.listProcesses()) : [])
  const terminals = input.terminals ?? (adapter.listTerminals ? await resolved(adapter.listTerminals()) : [])
  // Explicit snapshots are already deterministic input; do not consult the host process table
  // while unit tests or a restart reconciler supplies them.
  const protectedGroup = input.processes === undefined ? adapter.isProtectedProcessGroup : undefined
  const captured: CapturedService[] = []
  const inspectedGroups = new Set<number>()
  for (const item of processes) {
    // A terminal's shell lives in the worktree by design. It is the user's session, not a
    // service the turn started, so it is never captured and never stopped. What the user runs
    // inside it shares the shell's terminal and is captured normally.
    if (item.sessionShell) continue
    if (!processBelongsTo(root, item) || item.processGroupID === undefined || inspectedGroups.has(item.processGroupID)) {
      continue
    }
    inspectedGroups.add(item.processGroupID)
    if (item.processGroupID !== undefined && protectedGroup && await resolved(protectedGroup(item.processGroupID))) continue
    const listeners =
      item.listeners ??
      (item.processGroupID !== undefined && adapter.listenersForProcessGroup
        ? await resolved(adapter.listenersForProcessGroup(item.processGroupID))
        : undefined)
    const record = captureProcess(root, { ...item, ...(listeners ? { listeners } : {}) }, input.portAliases, input.proxyRoutes, now)
    if (record) captured.push(record)
  }
  const terminalRecords: CapturedService[] = []
  for (const item of terminals) {
    if (!terminalBelongsTo(root, item)) continue
    const listeners =
      item.listeners ??
      (adapter.listenersForTerminal ? await resolved(adapter.listenersForTerminal(item.id)) : undefined)
    const record = captureTerminal(root, { ...item, ...(listeners ? { listeners } : {}) }, input.portAliases, input.proxyRoutes, now)
    if (record) terminalRecords.push(record)
  }
  // A terminal can also appear in the process table. Keep one durable record for a managed
  // terminal and one for an independently owned process group, never one record per listener.
  const seen = new Set<string>()
  return [...captured, ...terminalRecords].filter((item) => {
    const key = item.managedTerminalID
      ? `terminal:${item.managedTerminalID}`
      : item.processGroupID === undefined
        ? `process:${item.command}:${item.relativeCwd}`
        : `group:${item.processGroupID}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const captureServices = captureOwnedServices

/** Assign each observed listener one stable preview alias and route, including listeners on ad-hoc ports. */
export function assignProxyRoutes(
  services: readonly CapturedService[],
  routes: readonly ServiceProxyRoute[],
): CapturedService[] {
  const byAlias = new Map(routes.flatMap((route) => (route.alias ? [[route.alias, route] as const] : [])))
  const explicit = new Set(
    services.flatMap((service) =>
      service.listeners.flatMap((listener) =>
        listener.alias && PORT_ALIASES.includes(listener.alias) ? [listener.alias] : [],
      ),
    ),
  )
  const available = PORT_ALIASES.filter((alias) => !explicit.has(alias))
  let nextAlias = 0
  return services.map((service) => {
    const listeners = service.listeners.map((listener) => {
      const assigned = listener.alias ?? available[nextAlias++]
      return { ...listener, ...(assigned ? { alias: assigned } : {}) }
    })
    return {
      ...service,
      listeners,
      proxyRoutes: listeners.flatMap((listener) => {
        if (!listener.alias) return []
        const route = byAlias.get(listener.alias)
        return route ? [{ ...route, port: listener.port }] : []
      }),
    }
  })
}

/** Reuse proxy routes persisted on a run when the live preview registry is unavailable. */
export function persistedProxyRoutes(
  services: readonly Pick<CapturedService, "proxyRoutes">[] | undefined,
): readonly ServiceProxyRoute[] {
  return services?.flatMap((service) => service.proxyRoutes) ?? []
}

/** Reconcile live state after a daemon restart using the same identity/CWD rules as stopping. */
export async function rediscoverOwnedServices(input: CaptureServicesInput): Promise<readonly CapturedService[]> {
  return captureOwnedServices(input)
}

function ownedCandidate(root: string, record: CapturedService, candidate: { cwd?: string; ownerID?: string }) {
  if (candidate.cwd !== undefined && inside(root, candidate.cwd)) return true
  return record.ownerID !== undefined && candidate.ownerID === record.ownerID && record.ownerID === serviceOwnerID(root)
}

function matchingProcess(root: string, record: CapturedService, candidates: readonly ProcessSnapshot[]) {
  return candidates.find((candidate) => {
    if (candidate.sessionShell) return false
    if (record.processGroupID === undefined || candidate.processGroupID === undefined) return false
    if (candidate.processGroupID !== record.processGroupID || !ownedCandidate(root, record, candidate)) return false
    // The stamped owner survives exec and chdir across every member of the
    // process group. If its original shell exited, a surviving child has a
    // different start identity but is still part of the same owned group.
    if (record.ownerID !== undefined && candidate.ownerID === record.ownerID) return true
    // A reused process group is not ours. If either side has a start identity, both must match.
    return record.processStartIdentity === undefined || candidate.processStartIdentity === record.processStartIdentity
  })
}

function matchingTerminal(root: string, record: CapturedService, candidates: readonly ManagedTerminalSnapshot[]) {
  return candidates.find((candidate) => {
    if (!record.managedTerminalID || candidate.id !== record.managedTerminalID || !ownedCandidate(root, record, candidate)) return false
    if (record.ownerID !== undefined && candidate.ownerID === record.ownerID) return true
    return record.processStartIdentity === undefined || candidate.processStartIdentity === record.processStartIdentity
  })
}

async function rediscover(root: string, record: CapturedService, adapter: ServiceAdapter) {
  const processes = adapter.listProcesses ? await resolved(adapter.listProcesses()) : []
  const terminals = adapter.listTerminals ? await resolved(adapter.listTerminals()) : []
  const matchedProcess = matchingProcess(root, record, processes)
  const process = matchedProcess && adapter.isProtectedProcessGroup && await resolved(adapter.isProtectedProcessGroup(matchedProcess.processGroupID!))
    ? undefined
    : matchedProcess
  return {
    process,
    terminal: matchingTerminal(root, record, terminals),
  }
}

async function listenersReleased(
  record: CapturedService,
  adapter: ServiceAdapter,
  processGroupID: number | undefined,
  terminalID: string | undefined,
) {
  const listeners = processGroupID !== undefined && adapter.listenersForProcessGroup
    ? await resolved(adapter.listenersForProcessGroup(processGroupID))
    : terminalID !== undefined && adapter.listenersForTerminal
      ? await resolved(adapter.listenersForTerminal(terminalID))
      : undefined
  if (listeners === undefined) return true
  return listeners.length === 0
}

async function ownerStillPresent(
  root: string,
  record: CapturedService,
  adapter: ServiceAdapter,
  processGroupID: number | undefined,
  terminalID: string | undefined,
) {
  if (processGroupID !== undefined && adapter.processGroupAlive) {
    return await resolved(adapter.processGroupAlive(processGroupID))
  }
  if (terminalID !== undefined && adapter.terminalAlive) {
    return await resolved(adapter.terminalAlive(terminalID))
  }
  const owner = await rediscover(root, record, adapter)
  return owner.process !== undefined || owner.terminal !== undefined
}

/**
 * Whether the owner and its listeners are both gone, or `undefined` when the probes could not
 * answer. The caller must treat `undefined` as "still there": an unanswerable probe is the one
 * case where guessing absence would let Arena trash a worktree with a live server inside it.
 */
async function provenAbsent(
  root: string,
  record: CapturedService,
  adapter: ServiceAdapter,
  processGroupID: number | undefined,
  terminalID: string | undefined,
): Promise<boolean | undefined> {
  try {
    if (await ownerStillPresent(root, record, adapter, processGroupID, terminalID)) return false
    return await listenersReleased(record, adapter, processGroupID, terminalID)
  } catch {
    return undefined
  }
}

/**
 * Stop each captured owner without ever using a port as an ownership key. The adapter is
 * deliberately injectable so restart, PID reuse, listener release, and terminal failures can
 * be tested without spawning or killing real processes.
 */
export async function stopOwnedServices(
  services: readonly CapturedService[],
  options: {
    readonly worktree: string
    readonly adapter?: ServiceAdapter
    readonly graceMs?: number
    readonly now?: Date
  },
): Promise<readonly ServiceStopRecord[]> {
  const adapter = options.adapter ?? defaultServiceAdapter
  const root = path.resolve(options.worktree)
  const stoppedGroups = new Set<number>()
  const stoppedTerminals = new Set<string>()
  const results: ServiceStopRecord[] = []
  for (const record of services) {
    const stoppedAt = options.now ?? new Date()
    const owner = await rediscover(root, record, adapter)
    const group = owner.process?.processGroupID
    const terminal = owner.terminal?.id
    if (!owner.process && !owner.terminal) {
      results.push({ ...stopRecord(record, "already_absent", true, stoppedAt), stoppedAt })
      continue
    }
    try {
      if (group !== undefined && adapter.stopProcessGroup && !stoppedGroups.has(group)) {
        stoppedGroups.add(group)
        await resolved(adapter.stopProcessGroup(group, "SIGTERM"))
      }
      if (terminal !== undefined && adapter.stopTerminal && !stoppedTerminals.has(terminal)) {
        stoppedTerminals.add(terminal)
        await resolved(adapter.stopTerminal(terminal))
      }
      if (adapter.wait && (options.graceMs ?? 0) > 0) await resolved(adapter.wait(options.graceMs ?? 0))
      let alive = await ownerStillPresent(root, record, adapter, group, terminal)
      if (alive && group !== undefined && adapter.stopProcessGroup) {
        await resolved(adapter.stopProcessGroup(group, "SIGKILL"))
        if (adapter.wait && (options.graceMs ?? 0) > 0) await resolved(adapter.wait(options.graceMs ?? 0))
        alive = await ownerStillPresent(root, record, adapter, group, terminal)
      }
      const released = !alive && await listenersReleased(record, adapter, group, terminal)
      results.push({ ...stopRecord(record, released ? "stopped" : "failed", released, stoppedAt), stoppedAt, ...(released ? {} : { error: "owner or listener is still present" }) })
    } catch (cause) {
      // A throw is a symptom, not a verdict. The owner may have exited on its own between
      // rediscovery and the signal, which is the outcome we wanted — so look at the machine
      // before recording anything. Only an owner and listeners that are provably gone earn
      // `already_absent`; a probe that cannot answer stays a failure.
      const absent = await provenAbsent(root, record, adapter, group, terminal)
      results.push(
        absent === true
          ? { ...stopRecord(record, "already_absent", true, stoppedAt), stoppedAt }
          : {
              ...stopRecord(record, "failed", false, stoppedAt),
              stoppedAt,
              error: cause instanceof Error ? cause.message : String(cause),
            },
      )
    }
  }
  return results
}

function stopRecord(record: CapturedService, status: ServiceStopRecord["status"], verified: boolean, _stoppedAt: Date) {
  return {
    command: record.command,
    relativeCwd: record.relativeCwd,
    status,
    verified,
    captured: record,
  }
}

export const stopServices = stopOwnedServices

type CommandProcess = ProcessSnapshot & { readonly processStartIdentity: string }

async function commandOutput(command: string, args: readonly string[]) {
  return await new Promise<string>((resolve) => {
    // `ps lstart` is parsed as a fixed 24-character column below. That width only holds in the
    // C locale: a Polish "czw." weekday is one character wider than "śr.", so with the user's
    // LANG every process line failed to parse on some days of the week and no service was captured.
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += String(chunk) })
    child.once("error", () => resolve(""))
    child.once("close", () => resolve(output))
  })
}

function parseLsofCwds(output: string) {
  const result: { pid: number; cwd: string }[] = []
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1))
      pid = Number.isInteger(value) ? value : undefined
    } else if (line.startsWith("n") && pid !== undefined) {
      result.push({ pid, cwd: line.slice(1) })
      pid = undefined
    }
  }
  return result
}

function parseOwnerProcesses(output: string) {
  const result = new Map<number, { ownerID: string; ownerRelativeCwd?: string }>()
  for (const line of output.split("\n")) {
    const process = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!process) continue
    const owner = process[2]!.match(/(?:^|\s)PASEO_ARENA_OWNER_ID=([a-f0-9]{64})(?:\s|$)/)
    if (!owner) continue
    const relative = process[2]!.match(/(?:^|\s)PASEO_ARENA_RELATIVE_CWD=([^\s]+)(?:\s|$)/)
    let ownerRelativeCwd: string | undefined
    if (relative) {
      try {
        ownerRelativeCwd = decodeURIComponent(relative[1]!)
      } catch {
        ownerRelativeCwd = undefined
      }
    }
    result.set(Number(process[1]), {
      ownerID: owner[1]!,
      ...(ownerRelativeCwd ? { ownerRelativeCwd } : {}),
    })
  }
  return result
}

function splitCommand(line: string) {
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const unquote = (token: string) => token.length >= 2 && ((token[0] === '"' && token.at(-1) === '"') || (token[0] === "'" && token.at(-1) === "'")) ? token.slice(1, -1) : token
  return tokens.map(unquote)
}

export type TerminalProcessRow = { readonly pid: number; readonly ppid: number; readonly tty: string }

const NO_TERMINAL = "??"

export function parseProcessTerminals(output: string): readonly TerminalProcessRow[] {
  const rows: TerminalProcessRow[] = []
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), tty: match[3]! })
  }
  return rows
}

/**
 * The process that opened a terminal session holds a controlling terminal its parent does not:
 * an interactive shell, whether the daemon opened it for a contestant seat or the user opened
 * it themselves. Everything started inside it inherits that same terminal from a parent that
 * already has it, so only the shell matches — a dev server the user runs there is still found.
 * A process whose parent is gone or is init is left alone: it could be anything.
 */
export function sessionShellPids(rows: readonly TerminalProcessRow[]): ReadonlySet<number> {
  const terminalByPid = new Map(rows.map((row) => [row.pid, row.tty] as const))
  const shells = new Set<number>()
  for (const row of rows) {
    if (!row.tty || row.tty === NO_TERMINAL) continue
    if (row.ppid <= 1) continue
    if (terminalByPid.get(row.ppid) !== NO_TERMINAL) continue
    shells.add(row.pid)
  }
  return shells
}

async function listRealProcesses(): Promise<readonly CommandProcess[]> {
  if (process.platform === "win32") return []
  const cwdRows = parseLsofCwds(await commandOutput("lsof", ["-nP", "-a", "-d", "cwd", "-F", "pn"]))
  // The shell hook stamps child environments before launch. Reading only the
  // ownership marker lets a service remain discoverable after it changes cwd.
  // The complete process environment is neither logged nor persisted.
  const owners = parseOwnerProcesses(await commandOutput("ps", ["axeww", "-o", "pid=,command="]))
  const shells = sessionShellPids(parseProcessTerminals(await commandOutput("ps", ["ax", "-o", "pid=,ppid=,tty="])))
  const cwds = new Map(cwdRows.map((row) => [row.pid, row.cwd] as const))
  const pids = [...new Set([...cwdRows.map((row) => row.pid), ...owners.keys()])].sort((a, b) => a - b)
  if (pids.length === 0) return []
  const output = await commandOutput("ps", [
    "-o",
    "pid=,pgid=,lstart=,command=",
    "-p",
    pids.join(","),
  ])
  const byPid = new Map<number, { processGroupID: number; start: string; command: string }>()
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/)
    if (match) byPid.set(Number(match[1]), { processGroupID: Number(match[2]), start: match[3]!, command: match[4]! })
  }
  return pids.flatMap((pid) => {
    const details = byPid.get(pid)
    if (!details) return []
    const tokens = splitCommand(details.command)
    const owner = owners.get(pid)
    return [{
      pid,
      processGroupID: details.processGroupID,
      ...(cwds.has(pid) ? { cwd: cwds.get(pid) } : {}),
      command: tokens[0] ?? details.command,
      args: tokens.slice(1),
      ...(owner ?? {}),
      ...(shells.has(pid) ? { sessionShell: true } : {}),
      processStartIdentity: details.start,
    }]
  })
}

async function realListeners(processGroupID: number) {
  const output = await commandOutput("lsof", ["-nP", "-a", "-g", String(processGroupID), "-iTCP", "-sTCP:LISTEN", "-FnP"])
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^n.*:(\d+)$/)
    if (!match) return []
    const port = Number(match[1])
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? [{ port }] : []
  })
}

/**
 * Whether a terminal session's shell works under any of `roots`: someone has a terminal open
 * there, the user's own or a contestant seat's. Its shell is never a service, and what runs in it
 * is theirs.
 */
export async function terminalOpenUnder(roots: readonly string[], adapter: ServiceAdapter = defaultServiceAdapter) {
  const processes = adapter.listProcesses ? await resolved(adapter.listProcesses()) : []
  return processes.some(
    (item) =>
      item.sessionShell && item.cwd !== undefined && roots.some((root) => inside(path.resolve(root), item.cwd!)),
  )
}

export const defaultServiceAdapter: ServiceAdapter = {
  listProcesses: listRealProcesses,
  listTerminals: () => [],
  stopProcessGroup: (processGroupID, signal) => {
    if (process.platform === "win32") return
    try {
      process.kill(-processGroupID, signal)
    } catch (cause) {
      // ESRCH is the outcome the signal was asking for: the group drained between
      // rediscovery and the kill. `processGroupAlive` below already reads the same errno
      // from the same syscall as "gone"; this keeps the two in agreement. Every other
      // errno — EPERM above all — is a real failure and has to keep throwing, because a
      // group we may not signal is one we must never report as stopped.
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    }
  },
  processGroupAlive: (processGroupID) => {
    if (process.platform === "win32") return false
    try { process.kill(-processGroupID, 0); return true } catch { return false }
  },
  listenersForProcessGroup: realListeners,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  isProtectedProcessGroup: async (processGroupID) => {
    if (process.platform === "win32") return false
    const own = Number((await commandOutput("ps", ["-o", "pgid=", "-p", String(process.pid)])).trim())
    return Number.isInteger(own) && own > 0 && own === processGroupID
  },
}

export * as ArenaServices from "./services"
