import { AssignmentRegistry, proxy, type Telemetry } from "./proxy"
import type { Store } from "./mongo"
import { isFinalState, isParkedPromotion } from "./domain"
import { join } from "node:path"
import { arenaDirectory } from "./database-upgrade"
import { ResearchUploader } from "./research"
import { arenaCredentials, type ArenaCredentials } from "./credentials"
import { createArenaBackend, type ArenaBackend } from "./backend"
import { idleSession, KeepAlive } from "./keep-alive"
import { referencesConfirmed } from "./media-reference"
import type { MediaCarriage } from "./engine-runtime/request-size"
import { GlobalBus } from "@/bus/global"

export const providerID = "arena"
export const registry = new AssignmentRegistry()
export const keepAlive = new KeepAlive()
let watchingIdle = false

let persistence: Promise<Store> | undefined
let telemetry: Telemetry | undefined
let recovery: Promise<void> | undefined
let built: { readonly credentials: ArenaCredentials; readonly backend: ArenaBackend } | undefined

export function enabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.OPENCODE_ARENA === "1"
}

export function setTelemetry(next: Telemetry | undefined) {
  telemetry = next
}

// What each running contestant does when its main session's step fails for good, by root session.
const runFailureHandlers = new Map<string, () => Promise<void>>()

// A handler that never settles must not hold the failure back from the model call.
const RUN_FAILURE_HANDLER_MS = 5_000

/** Registers the session's run-failure handler; the returned function removes it. */
export function onRunFailure(sessionID: string, handler: () => Promise<void>) {
  runFailureHandlers.set(sessionID, handler)
  return () => {
    if (runFailureHandlers.get(sessionID) === handler) runFailureHandlers.delete(sessionID)
  }
}

/**
 * Runs the session's handler before Core settles a step that fails without a retry: a content
 * filter, or any failure the retry policy gives up on. Never rejects, and waits at most 5 s.
 */
export async function runFailed(sessionID: string) {
  const handler = runFailureHandlers.get(sessionID)
  if (!handler) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      handler().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RUN_FAILURE_HANDLER_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function setStoreForTest(next: Store | undefined) {
  persistence = next ? Promise.resolve(next) : undefined
  recovery = undefined
}

export function recoverOnce(run: () => Promise<void>) {
  if (recovery) return recovery
  recovery = run().catch((error) => {
    recovery = undefined
    throw error
  })
  return recovery
}

/** Per home, like the store: an engine with another home never reads this engine's shells. */
export function shellLedgerDirectory() {
  return join(arenaDirectory(), "engine-shells")
}

async function openLocalStore() {
  const { connectLocalStore } = await import("./local-store")
  let uploader: ResearchUploader | undefined
  let backfill: Promise<void> | undefined
  const backfillController = new AbortController()
  const directory = arenaDirectory()
  const credentials = arenaCredentials()
  const local = await connectLocalStore({
    directory,
    researchPartition: credentials?.mode === "hosted" ? credentials.researchPartition : undefined,
    onMutation: () => uploader?.wake(),
    onClose: async () => {
      backfillController.abort()
      await uploader?.close()
      await backfill
    },
  })
  // Research is the hosted product's data; a BYOK build keeps everything local.
  if (credentials?.mode === "hosted") {
    if (!local.researchQueue) throw new Error("Hosted research queue is unavailable")
    uploader = new ResearchUploader({
      url: credentials.controlPlaneUrl,
      token: credentials.token,
      sourceID: local.sourceID,
      queue: local.researchQueue,
      warn: (warning) => console.warn("[arena-research] Upload status", warning),
    })
  }
  if (credentials?.mode === "hosted") {
    const accountID = credentials.researchAccountID
    backfill = (async () => {
      const signal = backfillController.signal
      let retryUnavailable = true
      while (!signal.aborted) {
        try {
          if (await local.backfillResearch(accountID, signal, { retryUnavailable })) return
        } catch {
          console.warn("[arena-research] Historical backfill pending; will retry")
        } finally {
          retryUnavailable = false
        }
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop)
            resolve()
          }, 60_000)
          timer.unref()
          signal.addEventListener("abort", stop, { once: true })
        })
      }
    })()
  }
  return local
}

export async function store() {
  if (persistence) return persistence
  persistence = openLocalStore().catch((error) => {
    persistence = undefined
    throw error
  })
  return persistence
}

export async function closeStore() {
  const current = persistence
  persistence = undefined
  recovery = undefined
  if (current) await (await current).close()
}

export async function isUnresolvedContestantSession(sessionID: string) {
  if (!enabled()) return false
  const database = await store()
  const assigned = registry.assignments.get(sessionID)
  if (assigned && !assigned.telemetry) return false
  const run = assigned
    ? await database.run(assigned.runID)
    : await database.runs.findOne({
        $or: [{ rootSessionID: sessionID }, { descendantSessionIDs: sessionID }],
      })
  if (!run) return assigned !== undefined
  const turn = await database.turn(run.turnID)
  if (!turn) return true
  return !isFinalState(turn.state)
}

export async function isBattleActiveCanonicalSession(sessionID: string) {
  if (!enabled()) return false
  const persisted = await store()
  const chat = await persisted.chatForSession(sessionID)
  if (chat?.status !== "battle_active" || chat.canonicalSessionID !== sessionID) return false
  // A promotion parked on the user still takes prompts: that prompt is how the user asks an agent
  // to resolve the thing Arena is parked on. `beginNormalTurn` allows the same state, and this
  // guard runs first, so leaving it out here refuses the send before anything can explain why.
  if (!chat.activeTurnID) return true
  const turn = await persisted.turn(chat.activeTurnID)
  return !turn || !isParkedPromotion(turn)
}

/** The control-plane routes for the startup credentials, or undefined before the daemon sent any. */
export function backend() {
  const credentials = arenaCredentials()
  if (!credentials) return undefined
  // One backend per credential set: the BYOK service checks the model catalog once per instance.
  if (built?.credentials !== credentials) {
    built = { credentials, backend: createArenaBackend(credentials, async () => (await store()).db) }
  }
  return built.backend
}

const contestantUpstream = (target: ArenaBackend) => `${target.url}/api/openrouter`

/** How a contestant request will carry its images and PDFs, which its size check counts. */
export function mediaCarriage(): MediaCarriage {
  const target = backend()
  if (target && !target.mediaByReference) return "local"
  return target && referencesConfirmed(contestantUpstream(target)) ? "reference" : "inline"
}

/** End cache pings on both legacy idle events and Core's native execution lifecycle. */
export function stopIdleKeepAlive(payload: Record<string, unknown>, waits: KeepAlive = keepAlive) {
  const legacy = idleSession(payload)
  if (legacy) {
    waits.idle(legacy)
    return
  }
  if (
    payload.type !== "session.execution.succeeded" &&
    payload.type !== "session.execution.failed" &&
    payload.type !== "session.execution.interrupted" &&
    payload.type !== "session.deleted"
  )
    return
  const properties = payload.properties
  if (typeof properties !== "object" || properties === null || !("sessionID" in properties)) return
  if (typeof properties.sessionID === "string") waits.idle(properties.sessionID)
}

export async function contestantFetch(input: string | URL | Request, init?: RequestInit) {
  const target = backend()
  if (!target) {
    return Response.json(
      { error: { message: "Arena OpenRouter credentials are unavailable", type: "arena_configuration_error" } },
      { status: 503 },
    )
  }
  // A session's loop reports idle when its turn ends, by finishing, Stop, an error or the battle's end.
  if (!watchingIdle) {
    watchingIdle = true
    GlobalBus.on("event", (event) => {
      stopIdleKeepAlive(event.payload)
    })
  }
  return proxy(new Request(input, init), registry, {
    upstream: contestantUpstream(target),
    fetch: target.fetch,
    telemetry,
    keepAlive,
    mediaByReference: target.mediaByReference,
    contentFilter: runFailed,
  })
}

export * as ArenaRuntime from "./runtime"
