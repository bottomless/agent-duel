import type { ArenaDb } from "./collection"
import type { ArenaContext, Caller, Fetch } from "./context"
import { validateOpenRouter, type ModelPool } from "./pool"
import { handleAssignmentsRequest } from "./assignments"
import { handleComparisonRequest } from "./comparison"
import { handleOpenRouterRequest } from "./openrouter"

export type ArenaServiceOptions = {
  /**
   * Who is calling. Return undefined to answer 401. Throw a Response to answer
   * with it, which is how a deployment refuses a known caller (403, 429). Any
   * other throw answers 503, so an outage never reads as a rejected session.
   */
  readonly resolveCaller: (request: Request) => Promise<Caller | undefined>
  readonly db: () => Promise<ArenaDb>
  readonly pool: ModelPool
  /** Pays for contestant, comparison and catalog calls. Without it the routes answer 503. */
  readonly openRouterApiKey: string | undefined
  readonly fetch?: Fetch
  readonly random?: () => number
  readonly uuid?: () => string
  readonly now?: () => Date
  /** Defaults to checking the pool against the key's OpenRouter catalog once per service. */
  readonly validateModels?: (apiKey: string) => Promise<void>
}

export type ArenaService = {
  readonly assignments: (request: Request) => Promise<Response>
  readonly openrouter: (request: Request) => Promise<Response>
  readonly comparison: (request: Request) => Promise<Response>
  /** Answers any of the routes above by path, or undefined when the path is not one of them. */
  readonly route: (request: Request) => Promise<Response | undefined>
}

export function createArenaService(options: ArenaServiceOptions): ArenaService {
  const fetch = options.fetch ?? globalThis.fetch
  let validation: Promise<void> | undefined
  const context: ArenaContext = {
    resolveCaller: options.resolveCaller,
    db: options.db,
    pool: options.pool,
    openRouterApiKey: options.openRouterApiKey?.trim() || undefined,
    fetch,
    random: options.random ?? Math.random,
    uuid: options.uuid ?? (() => crypto.randomUUID()),
    now: options.now ?? (() => new Date()),
    validateModels:
      options.validateModels ??
      ((apiKey) =>
        (validation ??= validateOpenRouter(options.pool, apiKey, fetch).catch((error) => {
          validation = undefined
          throw error
        }))),
  }
  const assignments = (request: Request) => handleAssignmentsRequest(request, context)
  const openrouter = (request: Request) => handleOpenRouterRequest(request, context)
  const comparison = (request: Request) => handleComparisonRequest(request, context)
  return {
    assignments,
    openrouter,
    comparison,
    async route(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/arena/assignments") return assignments(request)
      if (path === "/api/arena/comparison") return comparison(request)
      if (path.startsWith("/api/openrouter/")) return openrouter(request)
      return undefined
    },
  }
}
