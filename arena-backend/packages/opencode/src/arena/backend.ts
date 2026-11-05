import { createArenaService, type Fetch } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { defaultPool } from "@agent-duel/arena-service/default-pool"
import { isNetworkUnavailable } from "@agent-duel/arena-service/network"
import type { ModelPool } from "@agent-duel/arena-service/pool"
import { carryEnabled } from "./carry-note"
import type { ArenaCredentials } from "./credentials"

/**
 * The dev set draws three vendors. `OPENCODE_ARENA_BYOK_POOL=deepseek` draws DeepSeek on both sides
 * instead, which is how a paid path such as the carry replay is tried on the cheapest hosted model first.
 */
function byokPool(env: Readonly<Record<string, string | undefined>> = process.env): ModelPool {
  const requested = env.OPENCODE_ARENA_BYOK_POOL
  if (requested === undefined || requested === "") return defaultPool
  if (requested !== "deepseek")
    throw new Error(`OPENCODE_ARENA_BYOK_POOL must be unset or "deepseek", not "${requested}"`)
  const deepseek = (displayName: string) => ({
    displayName,
    slug: "deepseek/deepseek-v4.1-flash-1017",
    canonicalSlug: "deepseek/deepseek-v4.1-flash-20261017",
    contextWindow: 1_048_576,
    routing: { sort: "throughput", require_parameters: true, max_price: { prompt: 0.3, completion: 1.2 } },
  })
  return [deepseek("DeepSeek V4.1 Flash (A)"), deepseek("DeepSeek V4.1 Flash (B)")]
}

/**
 * Where the engine sends assignment, contestant, comparison and metadata requests. Both modes keep
 * the control plane's paths (`/api/arena/assignments`, `/api/arena/comparison`,
 * `/api/arena/metadata`, `/api/openrouter/...`) and `fetch` adds whatever credential the routes
 * need, so callers never branch on the mode.
 */
export interface ArenaBackend {
  readonly url: string
  readonly fetch: Fetch
}

// BYOK requests never leave the process; the service routes on the path alone.
const inProcessUrl = "http://arena.local"

export function createArenaBackend(credentials: ArenaCredentials, db: () => Promise<ArenaDb>): ArenaBackend {
  if (credentials.mode === "hosted") {
    return {
      url: credentials.controlPlaneUrl,
      fetch(input, init) {
        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${credentials.token}`)
        return globalThis.fetch(input, { ...init, headers })
      },
    }
  }
  // The user owns the key and the process, so the blinding here is a UI convention and every
  // battle belongs to the one local caller.
  // The carry replays captured calls, so a BYOK engine that carries also captures, into the voter's
  // own store: blinding here is a UI convention already.
  const carry = carryEnabled()
  const service = createArenaService({
    resolveCaller: async () => ({ id: "local" }),
    db,
    pool: byokPool(),
    openRouterApiKey: credentials.openRouterApiKey,
    networkUnavailable: (error) => isNetworkUnavailable(error, "openrouter.ai"),
    // The per-account limit guards the hosted key; this one is the user's.
    metadataRateLimit: null,
    streamRecovery: false,
    captureGenerations: carry,
    carry,
  })
  return {
    url: inProcessUrl,
    async fetch(input, init) {
      const response = await service.route(new Request(input, init))
      return response ?? Response.json({ error: "Not found" }, { status: 404 })
    },
  }
}
