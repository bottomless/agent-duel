import { createArenaService, type Fetch } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { defaultPool } from "@agent-duel/arena-service/default-pool"
import type { ArenaCredentials } from "./credentials"

/**
 * Where the engine sends assignment, contestant and comparison requests. Both modes keep the
 * control plane's paths (`/api/arena/assignments`, `/api/arena/comparison`, `/api/openrouter/...`)
 * and `fetch` adds whatever credential the routes need, so callers never branch on the mode.
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
  const service = createArenaService({
    resolveCaller: async () => ({ id: "local" }),
    db,
    pool: defaultPool,
    openRouterApiKey: credentials.openRouterApiKey,
  })
  return {
    url: inProcessUrl,
    async fetch(input, init) {
      const response = await service.route(new Request(input, init))
      return response ?? Response.json({ error: "Not found" }, { status: 404 })
    },
  }
}
