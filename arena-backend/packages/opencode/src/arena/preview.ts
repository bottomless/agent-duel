import { createHash } from "crypto"
import { connect, createServer } from "net"
import path from "path"
import type { Side } from "./domain"
import { SERVICE_OWNER_ENV, SERVICE_RELATIVE_CWD_ENV, serviceOwnerID } from "./services"

export const PORT_ALIASES = ["PASEO_PORT", "PASEO_PORT2", "PASEO_PORT3"] as const
export type PortAlias = (typeof PORT_ALIASES)[number]
export type PortAliases = Readonly<Record<PortAlias, number>>

export type Preview = {
  readonly hostname: string
  /** The first alias, retained for callers of the PR34 API. */
  readonly port: number
  readonly portAliases?: PortAliases
  readonly context?: ContestantContext
}

export type ContestantContext = {
  readonly branch?: string
  readonly trunkDirectory: string
  readonly trunkBranch?: string
}

export type Listener = {
  readonly port: number
  readonly command?: string
  readonly pid?: number
  readonly alias?: PortAlias
}

export type PreviewRoute = {
  readonly directory: string
  readonly hostname: string
  readonly portAliases: PortAliases
  readonly context?: ContestantContext
  readonly listeners: readonly Listener[]
  readonly state: "active" | "inactive"
  readonly ownership: "owned" | "ended"
  readonly registeredAt: Date
  readonly inactiveAt?: Date
  readonly releasedAt?: Date
}

export type PortAllocator = {
  readonly allocate: (count: number) => Promise<readonly number[]>
  readonly release?: (ports: readonly number[]) => void | Promise<void>
}

export type AllocatePortBankOptions = {
  readonly allocator?: PortAllocator | ((count: number) => Promise<readonly number[]>)
}

const routes = new Map<string, PreviewRoute>()
const routeHistory = new Map<string, PreviewRoute[]>()
const allocatedPorts = new Set<number>()
const pendingAllocations = new Map<string, Promise<PreviewRoute>>()
const releaseCallbacks = new Map<string, (ports: readonly number[]) => void | Promise<void>>()
let allocationQueue: Promise<void> = Promise.resolve()

export function hostname(chatID: string, turnIndex: number, side: Side) {
  const chat = createHash("sha256").update(chatID).digest("hex").slice(0, 8)
  return `turn${turnIndex + 1}-${side}--${chat}.localhost`
}

export function hostnameForAlias(hostname: string, alias: PortAlias) {
  if (alias === "PASEO_PORT") return hostname
  return `${alias === "PASEO_PORT2" ? "port2" : "port3"}--${hostname}`
}

/**
 * Arena hands out ports in sequence from a range below every OS ephemeral range (macOS 49152+,
 * Linux 32768+), so the OS never gives one to an outgoing connection, and the cursor is persisted,
 * so a number goes out once until the whole range has been used. A port an old transcript shows
 * is then never a later contestant's, which is what lets the forwarder in `retired-ports.ts` own it.
 */
export const PORT_RANGE = { first: 20_000, last: 29_999 } as const
// Dev tools that take a fixed port in the range: Vite's HMR socket and MongoDB.
const WELL_KNOWN_PORTS = new Set([24_678, 27_017, 27_018, 27_019, 28_017])

export type PortCursorStore = {
  readonly read: () => Promise<number | undefined>
  readonly write: (next: number) => Promise<void>
}

let cursorStore: PortCursorStore | undefined
let cursor: number | undefined
let externallyReserved: (port: number) => boolean = () => false

/** Persist the allocation cursor in the Arena store. Without one the cursor lives in memory. */
export function configurePortCursor(store: PortCursorStore | undefined) {
  if (store === cursorStore) return
  cursorStore = store
  cursor = undefined
}

/** Ports something else in this process holds, such as the retired-port forwarders. */
export function configureReservedPorts(reserved: (port: number) => boolean) {
  externallyReserved = reserved
}

function inRange(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= PORT_RANGE.first && port <= PORT_RANGE.last
}

async function sequentialPorts(count: number): Promise<number[]> {
  const stored = cursor ?? (await cursorStore?.read())
  let next = inRange(stored) ? stored : PORT_RANGE.first
  const size = PORT_RANGE.last - PORT_RANGE.first + 1
  const ports: number[] = []
  for (let scanned = 0; ports.length < count; scanned++) {
    if (scanned >= size) throw new Error(`Arena has no free port left in ${PORT_RANGE.first}-${PORT_RANGE.last}`)
    const port = next
    next = port === PORT_RANGE.last ? PORT_RANGE.first : port + 1
    if (allocatedPorts.has(port) || WELL_KNOWN_PORTS.has(port) || externallyReserved(port)) continue
    if (await portTaken(port)) continue
    ports.push(port)
  }
  cursor = next
  await cursorStore?.write(next)
  return ports
}

export function releasePort(port: number) {
  allocatedPorts.delete(port)
}

function allocatorFunction(input: AllocatePortBankOptions["allocator"]): PortAllocator {
  if (!input) {
    return {
      allocate: sequentialPorts,
      release: (ports) => ports.forEach(releasePort),
    }
  }
  return typeof input === "function" ? { allocate: input } : input
}

function validPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

/** Allocate the three aliases as one unit. A partial allocation is rolled back on failure. */
async function allocatePortBankLocked(options: AllocatePortBankOptions): Promise<PortAliases> {
  const allocator = allocatorFunction(options.allocator)
  const reservedBefore = new Set(allocatedPorts)
  let ports: readonly number[] = []
  try {
    ports = await allocator.allocate(PORT_ALIASES.length)
    if (
      ports.length !== PORT_ALIASES.length ||
      ports.some((port) => !validPort(port)) ||
      new Set(ports).size !== PORT_ALIASES.length ||
      ports.some((port) => reservedBefore.has(port))
    ) {
      throw new Error("Arena port allocator returned three distinct unreserved ports")
    }
    ports.forEach((port) => allocatedPorts.add(port))
    return {
      PASEO_PORT: ports[0]!,
      PASEO_PORT2: ports[1]!,
      PASEO_PORT3: ports[2]!,
    }
  } catch (error) {
    await allocator.release?.(ports.filter((port) => !reservedBefore.has(port)))
    throw error
  }
}

/** Serialize bank allocation so concurrent contestants cannot receive one port twice. */
export function allocatePortBank(options: AllocatePortBankOptions = {}): Promise<PortAliases> {
  const result = allocationQueue.then(() => allocatePortBankLocked(options))
  allocationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function aliasesFromPreview(preview: Preview): PortAliases {
  return (
    preview.portAliases ?? {
      PASEO_PORT: preview.port,
      PASEO_PORT2: preview.port,
      PASEO_PORT3: preview.port,
    }
  )
}

function previewWithAliases(preview: Preview): Preview & { readonly portAliases: PortAliases } {
  const portAliases = aliasesFromPreview(preview)
  if (preview.portAliases && new Set(Object.values(portAliases)).size !== PORT_ALIASES.length) {
    throw new Error("Arena preview aliases must use three distinct ports")
  }
  return { ...preview, port: portAliases.PASEO_PORT, portAliases }
}

function snapshot(route: PreviewRoute): PreviewRoute {
  return {
    ...route,
    portAliases: { ...route.portAliases },
    ...(route.context ? { context: { ...route.context } } : {}),
    listeners: route.listeners.map((listener) => ({ ...listener })),
  }
}

/** Register a preview route for a live contestant worktree. */
export function register(directory: string, preview: Preview, at = new Date()): PreviewRoute {
  const normalized = previewWithAliases(preview)
  const previous = routes.get(directory)
  if (previous?.ownership === "owned") {
    if (
      previous.hostname !== normalized.hostname ||
      JSON.stringify(previous.portAliases) !== JSON.stringify(normalized.portAliases)
    ) {
      throw new Error(`Arena preview route is already owned by ${directory}`)
    }
    return snapshot(previous)
  }

  const route: PreviewRoute = {
    directory,
    hostname: normalized.hostname,
    portAliases: { ...normalized.portAliases },
    ...(normalized.context ? { context: { ...normalized.context } } : {}),
    listeners: [],
    state: "active",
    ownership: "owned",
    registeredAt: at,
  }
  const ownedPorts = new Set(Object.values(route.portAliases))
  for (const other of routes.values()) {
    if (other.directory === directory || other.ownership === "ended") continue
    if (Object.values(other.portAliases).some((port) => ownedPorts.has(port))) {
      throw new Error(`Arena preview port is already owned by ${other.directory}`)
    }
  }
  routes.set(directory, route)
  for (const port of Object.values(route.portAliases)) allocatedPorts.add(port)
  return snapshot(route)
}

/** Allocate and register a stable bank for an environment exactly once. */
export async function allocatePreview(input: {
  readonly directory: string
  readonly chatID: string
  readonly turnIndex: number
  readonly side: Side
  readonly allocator?: PortAllocator | ((count: number) => Promise<readonly number[]>)
  readonly context?: ContestantContext
  readonly at?: Date
}): Promise<PreviewRoute> {
  const current = routes.get(input.directory)
  if (current?.ownership === "owned") return snapshot(current)
  const pending = pendingAllocations.get(input.directory)
  if (pending) return snapshot(await pending)
  const allocation = (async () => {
    const portAliases = await allocatePortBank({ allocator: input.allocator })
    try {
      const registered = register(
        input.directory,
        {
          hostname: hostname(input.chatID, input.turnIndex, input.side),
          port: portAliases.PASEO_PORT,
          portAliases,
          ...(input.context ? { context: input.context } : {}),
        },
        input.at,
      )
      if (typeof input.allocator === "object" && input.allocator.release) {
        releaseCallbacks.set(input.directory, input.allocator.release)
      }
      return registered
    } catch (error) {
      for (const port of Object.values(portAliases)) releasePort(port)
      if (typeof input.allocator === "object" && input.allocator.release) {
        await input.allocator.release(Object.values(portAliases))
      }
      throw error
    }
  })()
  pendingAllocations.set(input.directory, allocation)
  try {
    return snapshot(await allocation)
  } finally {
    pendingAllocations.delete(input.directory)
  }
}

/**
 * Release a bank reserved earlier if another program has since taken one of its ports. A warm
 * pair reserves its bank at warm-up and only this process tracks the reservation, so a port can
 * be taken while the pair waits for a send; the caller then allocates a fresh bank.
 */
export async function releaseTakenBank(directory: string): Promise<boolean> {
  const current = routes.get(directory)
  if (current?.ownership !== "owned") return false
  const taken = await Promise.all(Object.values(current.portAliases).map(portTaken))
  if (!taken.some(Boolean)) return false
  await release(directory, { ownershipEnded: true })
  return true
}

// Node listens with SO_REUSEADDR, so a bind can succeed beside a listener on another address.
// A connection that is accepted proves a listener; a failed bind proves any other holder.
async function portTaken(port: number) {
  if (await accepts(port)) return true
  if (!(await bindable(port))) return true
  // A server on [::1] alone would answer `localhost` before the contestant's own on 127.0.0.1.
  return !(await bindable(port, "::1"))
}

/** Whether any of these loopback ports accepts a connection, which only a listener can do. */
export async function anyListening(ports: readonly number[]) {
  const results = await Promise.all([...new Set(ports)].map(accepts))
  return results.some(Boolean)
}

function accepts(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    socket.setTimeout(500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(false))
  })
}

function bindable(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const probe = createServer()
    // A host without IPv6 cannot bind ::1 at all; that is no sign of another holder.
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(host === "::1" && error.code !== "EADDRINUSE"))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

/** Mark a route inactive while retaining its metadata for historical inspection. */
export function deactivate(directory: string, at = new Date()): PreviewRoute | undefined {
  const route = routes.get(directory)
  if (!route) return
  if (route.state === "inactive") return snapshot(route)
  const updated = { ...route, state: "inactive" as const, inactiveAt: at }
  routes.set(directory, updated)
  return snapshot(updated)
}

/** End ownership and release reservations. Call only after the owner is stopped or absent. */
export async function release(
  directory: string,
  options: { readonly ownershipEnded?: boolean; readonly at?: Date } = {},
): Promise<boolean> {
  const route = routes.get(directory)
  if (!route) return false
  if (!options.ownershipEnded) return false
  const released = {
    ...route,
    state: "inactive" as const,
    ownership: "ended" as const,
    inactiveAt: route.inactiveAt ?? options.at ?? new Date(),
    releasedAt: options.at ?? new Date(),
  }
  routes.delete(directory)
  retiredMaps.delete(directory)
  routeHistory.set(directory, [...(routeHistory.get(directory) ?? []), released])
  const ports = Object.values(route.portAliases)
  for (const port of ports) releasePort(port)
  await releaseCallbacks.get(directory)?.(ports)
  releaseCallbacks.delete(directory)
  return true
}

/** Convenience boundary for callers that have finished process-stop verification. */
export function endOwnership(directory: string, at = new Date()) {
  deactivate(directory, at)
  return release(directory, { ownershipEnded: true, at })
}

/** The route a live contestant owns at this directory, never a released one. */
export function activeRoute(directory: string): PreviewRoute | undefined {
  const current = routes.get(directory)
  return current?.state === "active" && current.ownership === "owned" ? snapshot(current) : undefined
}

/**
 * Earlier turns' ports and preview hostnames, each mapped to this directory's own with the same
 * alias. The shell gets them for the `open` shim, which retargets a URL before the user's browser
 * opens it: the browser is not a process the forwarder can trace to a contestant.
 */
export type RetiredPortMap = {
  readonly ports: Readonly<Record<number, number>>
  readonly hosts: Readonly<Record<string, string>>
}

const retiredMaps = new Map<string, RetiredPortMap>()
let openShimDirectory: string | undefined

export function configureOpenShim(directory: string | undefined) {
  openShimDirectory = directory
}

export function setRetiredPortMap(directory: string, map: RetiredPortMap) {
  if (!routes.has(directory)) return
  retiredMaps.set(directory, map)
}

function retiredEnvironment(directory: string, env: Record<string, string | undefined>): Record<string, string> {
  const map = retiredMaps.get(directory)
  const ports = Object.entries(map?.ports ?? {})
  if (!map || ports.length === 0) return {}
  const hosts = Object.entries(map.hosts)
  return {
    ARENA_RETIRED_PORTS: ports.map(([old, current]) => `${old}=${current}`).join(" "),
    ...(hosts.length ? { ARENA_RETIRED_HOSTS: hosts.map(([old, current]) => `${old}=${current}`).join(" ") } : {}),
    ...(openShimDirectory ? { PATH: [openShimDirectory, env["PATH"]].filter(Boolean).join(":") } : {}),
  }
}

export function route(directory: string): PreviewRoute | undefined {
  const current = routes.get(directory)
  if (current) return snapshot(current)
  const history = routeHistory.get(directory)
  return history?.at(-1) ? snapshot(history.at(-1)!) : undefined
}

export function routesFor(directory: string): readonly PreviewRoute[] {
  const current = routes.get(directory)
  return [...(routeHistory.get(directory) ?? []), ...(current ? [current] : [])].map(snapshot)
}

/** Record process listeners without assigning semantic service names to aliases. */
export function observe(directory: string, listeners: readonly Listener[]): PreviewRoute | undefined {
  const current = routes.get(directory)
  if (!current) return
  const aliases = new Map(Object.entries(current.portAliases).map(([alias, port]) => [port, alias as PortAlias]))
  const observed = listeners.map((listener) => ({
    ...listener,
    ...(listener.alias || !aliases.has(listener.port) ? {} : { alias: aliases.get(listener.port) }),
  }))
  const updated = { ...current, listeners: observed }
  routes.set(directory, updated)
  return snapshot(updated)
}

function previewBaseUrl(env: Record<string, string | undefined>): string | undefined {
  const configured = env["PASEO_ARENA_PREVIEW_BASE_URL"]?.trim()
  if (configured) return configured
  const listen = env["PASEO_LISTEN"]?.trim()
  if (!listen || listen.startsWith("/")) return undefined
  return /^\d+$/.test(listen) ? `http://localhost:${listen}` : `http://${listen}`
}

export function url(preview: Preview, env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = previewBaseUrl(env)
  if (!raw) return undefined
  try {
    const base = new URL(raw)
    base.hostname = preview.hostname
    base.pathname = ""
    base.search = ""
    base.hash = ""
    return base.origin
  } catch {
    return undefined
  }
}

export function environment(
  directory: string,
  env: Record<string, string | undefined> = process.env,
  cwd = directory,
): Record<string, string> {
  const current = routes.get(directory)
  if (!current || current.state !== "active") return {}
  const preview = {
    hostname: current.hostname,
    port: current.portAliases.PASEO_PORT,
    portAliases: current.portAliases,
  } satisfies Preview & { readonly portAliases: PortAliases }
  const previewUrl = url(preview, env)
  const previewUrl2 = url({ ...preview, hostname: hostnameForAlias(preview.hostname, "PASEO_PORT2") }, env)
  const previewUrl3 = url({ ...preview, hostname: hostnameForAlias(preview.hostname, "PASEO_PORT3") }, env)
  const relative = path.relative(path.resolve(directory), path.resolve(cwd))
  const ownerRelativeCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? relative || "."
    : "."
  return {
    HOST: "127.0.0.1",
    PORT: String(preview.port),
    PASEO_PORT: String(preview.portAliases.PASEO_PORT),
    PASEO_PORT2: String(preview.portAliases.PASEO_PORT2),
    PASEO_PORT3: String(preview.portAliases.PASEO_PORT3),
    [SERVICE_OWNER_ENV]: serviceOwnerID(directory),
    [SERVICE_RELATIVE_CWD_ENV]: encodeURIComponent(ownerRelativeCwd),
    ...(current.context
      ? {
          PASEO_CURRENT_BRANCH: current.context.branch ?? "",
          PASEO_TRUNK_DIR: current.context.trunkDirectory,
          PASEO_TRUNK_BRANCH: current.context.trunkBranch ?? "",
        }
      : {}),
    ARENA_PREVIEW_HOSTNAME: preview.hostname,
    ...(previewUrl ? { ARENA_PREVIEW_URL: previewUrl } : {}),
    ...(previewUrl2 ? { ARENA_PREVIEW_URL2: previewUrl2 } : {}),
    ...(previewUrl3 ? { ARENA_PREVIEW_URL3: previewUrl3 } : {}),
    BROWSER: "none",
    ...retiredEnvironment(directory, env),
  }
}

export function clearForTest() {
  routes.clear()
  routeHistory.clear()
  pendingAllocations.clear()
  allocatedPorts.clear()
  releaseCallbacks.clear()
  retiredMaps.clear()
  cursorStore = undefined
  cursor = undefined
  externallyReserved = () => false
  openShimDirectory = undefined
}

export * as ArenaPreview from "./preview"
