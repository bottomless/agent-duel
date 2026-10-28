/**
 * Keeps a contestant's cached prompt alive while its turn waits between two calls. Anthropic drops a
 * cached prompt five minutes after the last request that read it, and a long tool run, permission
 * prompt, subagent or background child easily waits longer; the next call then pays to write the
 * whole conversation again. While a session is busy and has no request in flight, its last request is
 * re-sent every four minutes with a one-token answer that nobody reads. Nothing reaches the
 * transcript, telemetry or the session.
 *
 * The engine cannot tell which side is Claude, so every waiting side is pinged the same way and the
 * proxy forwards only the ones whose provider caches by request (`arena-service/src/keep-alive.ts`).
 * A side that finished and waits for the user's reply is idle and gets no pings: so few battles get
 * a reply before the vote that the pings cost more than the cache writes they save.
 */
export const PING_EVERY_MS = 4 * 60_000
// A ping that failed fast still has the rest of the cache's five minutes for one more try.
export const RETRY_AFTER_MS = 15_000
const CACHE_TTL_MS = 5 * 60_000
// A wait this long is rarely a tool run; whatever it waits for, stop paying to keep the cache.
export const MAX_WAIT_MS = 30 * 60_000
// Sessions that never report idle (a crashed run) must not keep their conversations forever.
const MAX_SESSIONS = 256

/** `kept` when the proxy took the ping, `unsupported` when it forwarded it as a request (a proxy
 * from before pings), `failed` when it did not answer. */
export type PingResult = "kept" | "unsupported" | "failed"
export type Ping = () => Promise<PingResult>

type Entry = {
  inFlight: number
  ping?: Ping
  /** When the last request or ping that used the cached prompt started. */
  usedAt: number
  /** When the last request ended, while none is in flight. */
  waitingSince?: number
  cancel?: () => void
}

export type KeepAliveOptions = {
  readonly everyMs?: number
  readonly maxWaitMs?: number
  readonly now?: () => number
  readonly schedule?: (run: () => void, ms: number) => () => void
}

function schedule(run: () => void, ms: number) {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class KeepAlive {
  private readonly sessions = new Map<string, Entry>()
  private readonly everyMs: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => () => void
  private supported = true

  constructor(options: KeepAliveOptions = {}) {
    this.everyMs = options.everyMs ?? PING_EVERY_MS
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? schedule
  }

  /**
   * A request for the session is leaving. Call the returned function once when it has ended, with a
   * ping that re-sends it when the next call continues its prompt, or with none when it failed or
   * replaced the conversation (compaction).
   */
  begin(sessionID: string) {
    const startedAt = this.now()
    let entry = this.sessions.get(sessionID)
    if (!entry) {
      entry = { inFlight: 0, usedAt: startedAt }
      this.sessions.set(sessionID, entry)
      if (this.sessions.size > MAX_SESSIONS) this.idle(this.sessions.keys().next().value!)
    }
    const current = entry
    current.inFlight++
    current.waitingSince = undefined
    this.disarm(current)
    let ended = false
    return (ping?: Ping) => {
      if (ended) return
      ended = true
      // The session went idle while the request was out: its turn is over.
      if (this.sessions.get(sessionID) !== current) return
      current.inFlight = Math.max(0, current.inFlight - 1)
      current.ping = ping
      current.usedAt = Math.max(current.usedAt, startedAt)
      current.waitingSince = this.now()
      this.arm(sessionID, current)
    }
  }

  /** The session's loop stopped: it finished, was stopped, failed, or its battle ended. */
  idle(sessionID: string) {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    this.disarm(entry)
    this.sessions.delete(sessionID)
  }

  private disarm(entry: Entry) {
    entry.cancel?.()
    entry.cancel = undefined
  }

  private arm(sessionID: string, entry: Entry) {
    this.disarm(entry)
    if (!this.supported || entry.inFlight > 0 || !entry.ping || entry.waitingSince === undefined) return
    const now = this.now()
    // The cache counts from when a request started, so a long answer leaves less of it.
    const due = Math.max(now, entry.usedAt + this.everyMs)
    if (due - entry.waitingSince > this.maxWaitMs) return
    entry.cancel = this.schedule(() => void this.fire(sessionID, entry), due - now)
  }

  private async fire(sessionID: string, entry: Entry, retry = false) {
    entry.cancel = undefined
    const ping = entry.ping
    if (!this.supported || this.sessions.get(sessionID) !== entry || entry.inFlight > 0 || !ping) return
    const lastUse = entry.usedAt
    entry.usedAt = this.now()
    const result = await ping()
    if (result === "unsupported" && this.supported) {
      this.supported = false
      console.warn("[arena-keep-alive] The proxy does not take keep-alive pings; stopped sending them")
    }
    if (this.sessions.get(sessionID) !== entry) return
    if (result === "failed" && !retry && this.retry(sessionID, entry, ping, lastUse)) return
    if (result !== "kept") {
      // Another request may have ended meanwhile and left its own ping; that one still stands.
      if (entry.ping === ping) entry.ping = undefined
      return
    }
    this.arm(sessionID, entry)
  }

  /** Tries a failed ping once more if the cache it keeps can still be alive by then. */
  private retry(sessionID: string, entry: Entry, ping: Ping, lastUse: number) {
    // A request that started or ended meanwhile owns the next ping.
    if (entry.ping !== ping || entry.inFlight > 0 || entry.cancel || entry.waitingSince === undefined) return false
    const due = this.now() + RETRY_AFTER_MS
    // A ping that timed out has used up the cache's five minutes.
    if (due >= lastUse + CACHE_TTL_MS || due - entry.waitingSince > this.maxWaitMs) return false
    entry.cancel = this.schedule(() => void this.fire(sessionID, entry, true), RETRY_AFTER_MS)
    return true
  }
}

/** The session a `session.status` event reports idle, if it is one. */
export function idleSession(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return undefined
  const event = payload as { type?: unknown; properties?: { sessionID?: unknown; status?: { type?: unknown } } }
  if (event.type !== "session.status" || event.properties?.status?.type !== "idle") return undefined
  return typeof event.properties.sessionID === "string" ? event.properties.sessionID : undefined
}

export * as ArenaKeepAlive from "./keep-alive"
