import { AssignmentRegistry, proxy, type Telemetry } from "./proxy"
import type { Store } from "./mongo"
import { isFinalState, isParkedPromotion } from "./domain"
import { homedir } from "node:os"
import { join } from "node:path"
import { ResearchUploader } from "./research"
import { arenaCredentials, type ArenaCredentials } from "./credentials"
import { markInitialDispatch } from "./dispatch"
import { createArenaBackend, type ArenaBackend } from "./backend"
import { idleSession, KeepAlive } from "./keep-alive"
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

async function openLocalStore() {
  const { connectLocalStore } = await import("./local-store")
  let uploader: ResearchUploader | undefined
  let backfill: Promise<void> | undefined
  const backfillController = new AbortController()
  const directory = join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "arena")
  const credentials = arenaCredentials()
  const local = await connectLocalStore({
    directory,
    researchPartition: credentials?.mode === "hosted" ? credentials.researchPartition : undefined,
    ...(credentials?.mode === "hosted"
      ? { adoption: { accountID: credentials.researchAccountID, accounts: credentials.adoptAccounts } }
      : {}),
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
      const sessionID = idleSession(event.payload)
      if (sessionID) keepAlive.idle(sessionID)
    })
  }
  return proxy(new Request(input, init), registry, {
    upstream: `${target.url}/api/openrouter`,
    fetch: target.fetch,
    telemetry,
    onDispatch: (metadata) => markInitialDispatch(metadata.sessionID),
    keepAlive,
  })
}

export * as ArenaRuntime from "./runtime"
