import { AssignmentRegistry, proxy, type Telemetry } from "./proxy"
import type { Store } from "./mongo"
import { isFinalState, isParkedPromotion } from "./domain"
import { homedir } from "node:os"
import { join } from "node:path"
import { ResearchUploader } from "./research"
import { arenaCredentials, type ArenaCredentials } from "./credentials"
import { markInitialDispatch } from "./dispatch"
import { createArenaBackend, type ArenaBackend } from "./backend"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RunDocument } from "./records"
import {
  environmentReferences,
  isEnvironmentTool,
  retargetMessages,
  retargetToolInput,
  type Environment,
} from "./environment-context"

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

async function sessionEnvironment(sessionID: string) {
  if (!enabled()) return undefined
  const assigned = registry.assignments.get(sessionID)
  if (assigned && !assigned.telemetry) return undefined
  const database = await store()
  const run = assigned
    ? await database.run(assigned.runID)
    : await database.runs.findOne({ $or: [{ rootSessionID: sessionID }, { descendantSessionIDs: sessionID }] })
  if (!run) return undefined
  const turn = await database.turn(run.turnID)
  if (!turn) return undefined
  const environment = (entry: RunDocument): Environment => ({
    portAliases: entry.portAliases,
    previewUrls: Object.fromEntries(
      (entry.services ?? []).flatMap((service) =>
        service.proxyRoutes.flatMap((route) => (route.alias && route.url ? [[route.alias, route.url]] : [])),
      ),
    ),
  })
  const history = (await database.runsForChat(turn.chatID))
    .filter((entry) => entry.createdAt.getTime() < run.createdAt.getTime())
    .map(environment)
  return { run, turn, history, current: environment(run) }
}

/** Build each request from the untouched session, including retries and compaction requests. */
export async function projectEnvironment(input: SessionV1.WithParts[]) {
  if (input.length === 0) return input
  const context = await sessionEnvironment(input[0].info.sessionID)
  if (!context) return input
  return retargetMessages(input, context.history, context.current, context.run.createdAt.getTime())
}

/** Opaque historical outputs may still contain old ports. Enforce known endpoint arguments at execution too. */
export async function projectToolEnvironment(sessionID: string, tool: string, args: Record<string, unknown>) {
  if (!isEnvironmentTool(tool)) return args
  const context = await sessionEnvironment(sessionID)
  if (!context || isFinalState(context.turn.state)) return args
  // A current port can reuse a different historical alias; an already-current command must stay current.
  const mapping = environmentReferences([...context.history, context.current], context.current)
  return retargetToolInput(tool, args, mapping)
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
