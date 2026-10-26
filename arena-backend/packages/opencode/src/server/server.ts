import { timingSafeEqual } from "node:crypto"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { OpenApi } from "effect/http-api"
import { Session as CoreSession } from "@opencode/core/session"
import { Model as CoreModel } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { createRoutes } from "@opencode/server/routes"
import type { ServerOptions } from "@opencode/server/options"
import { Api } from "@opencode/server/api"
import { sanitizeV2 } from "@/arena/v2-privacy"
import { arenaCredentials, hashArenaControlToken } from "@/arena/credentials"
import { routeLayer as arenaRouteLayer } from "@/arena/http-runtime"
import { ArenaRuntime } from "@/arena/runtime"
import { ArenaService, type NormalTurnStart } from "@/arena/service"
import { MessageID, SessionID } from "@/session/schema"
import { version as opencodeVersion } from "../../package.json"
;(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = ServerOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
}

type Runtime = {
  readonly scope: Scope.Closeable
  readonly handler: (request: Request) => Promise<Response>
}

let currentRuntime: Runtime | undefined
let defaultPending: Promise<Runtime> | undefined
export let url: URL | undefined

function expectedControlToken(request: Request) {
  const expected = arenaCredentials()?.controlTokenHash
  const supplied = request.headers.get("x-paseo-control-token")
  if (!expected || !supplied) return false
  const actual = Buffer.from(hashArenaControlToken(supplied), "hex")
  const digest = Buffer.from(expected, "hex")
  return actual.byteLength === digest.byteLength && timingSafeEqual(actual, digest)
}

function allowed(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/"
  return request.method === "GET" && path === "/global/health" ? true : expectedControlToken(request)
}

function unauthorized() {
  return new Response(null, { status: 404 })
}

function databaseOptions(options: ServerOptions): ServerOptions {
  if (options.database) return options
  const configured = process.env.OPENCODE_DB
  const channel = "local"
  const filename =
    configured ??
    (["latest", "dev", "beta", "next", "prod"].includes(channel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel}.db`)
  return { ...options, database: { path: filename } }
}

async function protectedSessionMutation(request: Request, pathname: string) {
  if (!ArenaRuntime.enabled() || request.method === "GET" || request.method === "HEAD") return false
  const match = /^\/api\/session\/([^/]+)/.exec(pathname)
  if (!match) return false
  // Waiting is a read-side synchronization primitive. It may block while a
  // battle is active, so keep it available for canonical-session observers.
  const suffix = pathname.slice(match[0].length)
  if (suffix === "/wait") return false
  const sessionID = decodeURIComponent(match[1])
  if (await ArenaRuntime.isUnresolvedContestantSession(sessionID)) return true
  // The daemon reapplies canonical launch variables after an SSE reconnect.
  // Keep this process-local sync available while Arena owns the conversation.
  if (request.method === "PUT" && suffix === "/environment") return false
  return ArenaRuntime.isBattleActiveCanonicalSession(sessionID)
}

function copyHeaders(source: Response) {
  const headers = new Headers(source.headers)
  headers.delete("content-length")
  return headers
}

async function sanitizeJson(response: Response) {
  try {
    const body = await response.json()
    return new Response(JSON.stringify(sanitizeV2(body)), {
      status: response.status,
      statusText: response.statusText,
      headers: copyHeaders(response),
    })
  } catch {
    return response
  }
}

async function sanitizeCatalogJson(response: Response) {
  try {
    const body = await response.json()
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const output = { ...(body as Record<string, unknown>) }
      if (Array.isArray(output.data)) output.data = []
      else if (Array.isArray(output.models)) output.models = []
      else if (Array.isArray(output.providers)) output.providers = []
      return new Response(JSON.stringify(output), {
        status: response.status,
        statusText: response.statusText,
        headers: copyHeaders(response),
      })
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: response.status,
      statusText: response.statusText,
      headers: copyHeaders(response),
    })
  } catch {
    return response
  }
}

function sanitizeSse(response: Response) {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let boundary = pending.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary + 2)
        pending = pending.slice(boundary + 2)
        controller.enqueue(encoder.encode(sanitizeSseFrame(frame)))
        boundary = pending.indexOf("\n\n")
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(sanitizeSseFrame(pending)))
    },
  })
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: copyHeaders(response),
  })
}

function sanitizeSseFrame(frame: string) {
  return frame
    .split(/(\r?\n)/)
    .map((line) => {
      if (!line.startsWith("data:")) return line
      const prefix = line.slice(0, 5)
      const text = line.slice(5).trimStart()
      try {
        return `${prefix} ${JSON.stringify(sanitizeV2(JSON.parse(text)))}`
      } catch {
        return line
      }
    })
    .join("")
}

type NativePromptAdmission = {
  readonly sessionID: SessionID
  readonly messageID: MessageID
}

type PreparedNativePrompt = {
  readonly request: Request
  readonly admission?: NativePromptAdmission
}

function arenaRefusalMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : ""
  // Arena's own coordination errors are safe and actionable. Upstream/provider errors are
  // intentionally collapsed so credentials, model identities, and transport details stay private.
  if (message.startsWith("Arena ")) return message
  return "Arena refused this turn"
}

async function prepareNativePrompt(
  request: Request,
  context: Context.Context<never>,
): Promise<Request | Response | PreparedNativePrompt> {
  const requestURL = new URL(request.url)
  const match = /^\/api\/session\/([^/]+)\/prompt$/.exec(requestURL.pathname)
  if (request.method !== "POST" || !match || !ArenaRuntime.enabled()) return request
  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.clone().json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return request
    body = { ...(parsed as Record<string, unknown>) }
  } catch {
    return request
  }
  const sessionID = decodeURIComponent(match[1]) as CoreSession.ID
  const messageID = typeof body.id === "string" ? body.id : MessageID.ascending()
  body.id = messageID
  let persisted: { readonly model?: { readonly providerID: string; readonly id: string } } | undefined
  try {
    const sessions = Context.getUnsafe(context, CoreSession.Service)
    persisted = await Effect.runPromise(Effect.provideContext(sessions.get(sessionID), context))
  } catch {
    // Let the official route return its normal not-found response without creating an Arena
    // reservation for an invalid session.
    return request
  }
  const requested = body.model
  const requestedModel =
    requested && typeof requested === "object" && !Array.isArray(requested)
      ? {
          providerID:
            typeof (requested as Record<string, unknown>).providerID === "string"
              ? (requested as Record<string, string>).providerID
              : undefined,
          modelID:
            typeof (requested as Record<string, unknown>).modelID === "string"
              ? (requested as Record<string, string>).modelID
              : typeof (requested as Record<string, unknown>).id === "string"
                ? (requested as Record<string, string>).id
                : undefined,
        }
      : undefined
  const model =
    requestedModel?.providerID && requestedModel.modelID
      ? requestedModel
      : persisted.model
        ? { providerID: persisted.model.providerID, modelID: persisted.model.id }
        : undefined
  // The native v2 prompt schema selects the session model, so this private
  // request hint must not be forwarded as an unknown payload field.
  delete body.model
  let started: NormalTurnStart | undefined
  try {
    const arena = Context.getUnsafe(context, ArenaService.Service)
    const sessions = Context.getUnsafe(context, CoreSession.Service)
    started = await Effect.runPromise(
      Effect.provideContext(
        arena.beginNormalTurn({
          sessionID,
          messageID: messageID as MessageID,
          ...(model?.providerID && model.modelID
            ? { model: { providerID: Provider.ID.make(model.providerID), modelID: CoreModel.ID.make(model.modelID) } }
            : {}),
        }),
        context,
      ),
    )
    if (started) {
      const turn = started
      await Effect.runPromise(
        Effect.provideContext(
          Effect.gen(function* () {
            yield* sessions.switchModel({
              sessionID,
              model: {
                id: CoreModel.ID.make(turn.model.modelID),
                providerID: turn.model.providerID,
                variant: CoreModel.VariantID.make(turn.variant),
              },
            })
            // Keep the workspace warning beside the user's prompt for the model, while the
            // native user row and its public timeline retain the exact submitted text.
            if (turn.note) yield* sessions.synthetic({ sessionID, text: turn.note, resume: false })
          }),
          context,
        ),
      )
    }
  } catch (cause) {
    if (started) {
      try {
        const arena = Context.getUnsafe(context, ArenaService.Service)
        await Effect.runPromise(
          Effect.provideContext(
            arena.recordNormalTurn({ sessionID: sessionID as SessionID, messageID: messageID as MessageID }),
            context,
          ),
        )
      } catch {
        // The refusal remains generic; Arena's reconciliation logs the detailed cause.
      }
    }
    return new Response(JSON.stringify({ error: arenaRefusalMessage(cause) }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })
  }
  return {
    request: new Request(request, { body: JSON.stringify(body) }),
    ...(started ? { admission: { sessionID: sessionID as SessionID, messageID: messageID as MessageID } } : {}),
  }
}

async function boundary(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  context: Context.Context<never>,
) {
  if (!allowed(request)) return unauthorized()
  const requestURL = new URL(request.url)
  const requestPath = requestURL.pathname.replace(/\/+$/, "") || "/"
  if (request.method === "GET" && requestPath === "/global/health") {
    return Response.json({ healthy: true, version: opencodeVersion })
  }
  if ((requestPath === "/doc" || requestPath === "/openapi.json") && process.env.OPENCODE_ARENA_ENABLE_DOCS !== "1") {
    return unauthorized()
  }
  if (await protectedSessionMutation(request, requestPath)) {
    return new Response(JSON.stringify({ error: "Session is controlled by an unresolved Arena battle" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })
  }
  const prepared = await prepareNativePrompt(request, context)
  if (prepared instanceof Response) return prepared
  const preparedRequest = prepared instanceof Request ? prepared : prepared.request
  const response = await handler(preparedRequest)
  if (!(prepared instanceof Request) && prepared.admission && !response.ok) {
    try {
      const arena = Context.getUnsafe(context, ArenaService.Service)
      await Effect.runPromise(Effect.provideContext(arena.recordNormalTurn(prepared.admission), context))
    } catch {
      // Preserve the route's failure. The reconciliation path also releases the reservation.
    }
  }
  const pathname = requestPath
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return response
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("text/event-stream")) return sanitizeSse(response)
  if (contentType.includes("application/json")) {
    if (requestPath === "/api/model" || requestPath === "/api/provider") return sanitizeCatalogJson(response)
    return sanitizeJson(response)
  }
  return response
}

async function buildRuntime(options: ServerOptions): Promise<Runtime> {
  const scope = Scope.makeUnsafe()
  try {
    const routes = createRoutes(
      {
        ...databaseOptions(options),
        // Arena supplies its two opaque models through the Arena provider. Avoid the
        // upstream models.dev fetch, which adds latency and can fail before the daemon
        // reaches its authenticated native boundary. Explicit test/CLI options may opt in.
        models: { fetch: false, ...options.models },
        // The daemon has its own private control-token boundary. Do not enable
        // upstream Basic-auth middleware on the embedded route graph.
        password: undefined,
        app: { version: opencodeVersion, ...(options.app ?? {}) },
      },
      () => [],
      [],
      arenaRouteLayer,
    )
    // The Bun host supplies the platform services at runtime. The official route
    // graph carries a broad inferred environment through its extension layer; keep
    // that implementation detail at this one host boundary.
    const build = Effect.provide(HttpServer.layerServices)(Layer.buildWithScope(routes, scope))
    const context = await Effect.runPromise(build)
    const routeHandler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const handler = async (request: Request) => boundary(request, routeHandler, context)
    return { scope, handler }
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.fail(cause)).pipe(Effect.ignore))
    throw cause
  }
}

function defaultApp(): ServerApp {
  const fetch = (request: Request) => {
    const pending = currentRuntime
      ? Promise.resolve(currentRuntime)
      : (defaultPending ??= buildRuntime({ app: { version: opencodeVersion } }).then((runtime) => {
          currentRuntime ??= runtime
          return runtime
        }))
    pending.catch(() => {
      defaultPending = undefined
    })
    return pending.then((runtime) => runtime.handler(request))
  }
  return {
    fetch,
    request(input, init) {
      return fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

let defaultValue: { app: ServerApp } | undefined
export function Default() {
  return (defaultValue ??= { app: defaultApp() })
}

export async function openapi() {
  return OpenApi.fromApi(Api)
}

export async function dispose() {
  const runtime = currentRuntime
  currentRuntime = undefined
  if (runtime) await Effect.runPromise(Scope.close(runtime.scope, Exit.void))
}

export async function listen(opts: ListenOptions): Promise<Listener> {
  const runtime = await buildRuntime({ ...opts, hostname: undefined, port: undefined })
  // Native event heartbeats are 15 seconds apart; Bun's default idle timeout is 10.
  const server = Bun.serve({ hostname: opts.hostname, port: opts.port, fetch: runtime.handler, idleTimeout: 60 })
  const listenerPort = server.port ?? opts.port
  const listenerUrl = new URL(`http://${opts.hostname}:${listenerPort}`)
  url = listenerUrl
  currentRuntime = runtime
  return {
    hostname: opts.hostname,
    port: listenerPort,
    url: listenerUrl,
    stop: async (close = false) => {
      server.stop(close)
      await Effect.runPromise(Scope.close(runtime.scope, Exit.void))
      if (currentRuntime === runtime) currentRuntime = undefined
      if (url === listenerUrl) url = undefined
    },
  }
}

export * as Server from "./server"
