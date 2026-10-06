import { AssignmentRegistry, proxy, type Telemetry } from "./proxy"
import type { Store } from "./mongo"
import { isFinalState, isParkedPromotion } from "./domain"
import { homedir } from "node:os"
import { join } from "node:path"
import { ResearchUploader } from "./research"
import { arenaCredentials, type ArenaCredentials } from "./credentials"
import { markInitialDispatch } from "./dispatch"
import { createArenaBackend, type ArenaBackend } from "./backend"

export const providerID = "arena"
export const registry = new AssignmentRegistry()

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
  const directory = join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "arena")
  const local = await connectLocalStore({
    directory,
    onMutation: (mutation) => uploader?.enqueue(mutation),
    onClose: () => uploader?.close(),
  })
  // Research is the hosted product's data; a BYOK build keeps everything local.
  const credentials = arenaCredentials()
  if (credentials?.mode === "hosted") {
    uploader = new ResearchUploader({
      url: credentials.controlPlaneUrl,
      token: credentials.token,
      sourceID: local.sourceID,
      warn: (warning) => console.warn("[arena-research] Dropped research data", warning),
    })
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
  return proxy(new Request(input, init), registry, {
    upstream: `${target.url}/api/openrouter`,
    fetch: target.fetch,
    telemetry,
    onDispatch: (metadata) => markInitialDispatch(metadata.sessionID),
  })
}

export * as ArenaRuntime from "./runtime"
