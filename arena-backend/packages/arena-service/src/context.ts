import type { ArenaDb } from "./collection"
import type { ModelPool } from "./pool"

/** The only facts the battle routes read about whoever is calling. */
export type Caller = {
  readonly id: string
  readonly email?: string
  readonly name?: string | null
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type ArenaContext = {
  readonly resolveCaller: (request: Request) => Promise<Caller | undefined>
  readonly db: () => Promise<ArenaDb>
  readonly pool: ModelPool
  readonly openRouterApiKey: string | undefined
  readonly fetch: Fetch
  readonly random: () => number
  readonly uuid: () => string
  readonly now: () => Date
  readonly validateModels: (apiKey: string) => Promise<void>
}

type Failure = (message: string, status: number) => Response

export async function authorize(request: Request, context: ArenaContext, failure: Failure) {
  try {
    const caller = await context.resolveCaller(request)
    return caller ?? failure("Unauthorized", 401)
  } catch (error) {
    if (error instanceof Response) return error
    console.error("[arena-service] Arena caller could not be resolved", error)
    return failure("Arena accounts are unavailable", 503)
  }
}
