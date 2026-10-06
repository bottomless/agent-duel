import { arenaCredentials, hashArenaControlToken } from "@/arena/credentials"
import { ArenaRuntime } from "@/arena/runtime"
import { timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const controlTokenHeader = "x-paseo-control-token"
const arenaDocsFlag = "OPENCODE_ARENA_ENABLE_DOCS"

function isControlRequest(request: HttpServerRequest.HttpServerRequest) {
  const expected = arenaCredentials()?.controlTokenHash
  const token = request.headers[controlTokenHeader]
  if (!expected || !token) return false
  const actual = Buffer.from(hashArenaControlToken(token), "hex")
  const digest = Buffer.from(expected, "hex")
  return actual.byteLength === digest.byteLength && timingSafeEqual(actual, digest)
}

function publiclyAllowed(request: HttpServerRequest.HttpServerRequest) {
  const pathname = new URL(request.url, "http://localhost").pathname
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  if (path === "/global/health" && request.method === "GET") return true
  return false
}

function disabledArenaRoute(path: string) {
  return path === "/api" || path.startsWith("/api/")
}

export const arenaBrowserBoundaryLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    if (!ArenaRuntime.enabled()) return yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname.replace(/\/+$/, "") || "/"
    if (path === "/doc")
      return process.env[arenaDocsFlag] === "1" ? yield* effect : HttpServerResponse.empty({ status: 404 })
    if (disabledArenaRoute(path)) return HttpServerResponse.empty({ status: 404 })
    if (isControlRequest(request)) return yield* effect
    if (publiclyAllowed(request)) return yield* effect
    return HttpServerResponse.empty({ status: 404 })
  }),
).layer
