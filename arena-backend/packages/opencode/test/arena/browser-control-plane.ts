import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createArenaService, type Fetch } from "@agent-duel/arena-service"
import { defaultPool } from "@agent-duel/arena-service/default-pool"
import { connectLocalStore } from "../../src/arena/local-store"

const TEST_USER_ID = "single-agent-test-user"
const MEDIUM_SLUG = "openai/gpt-5.6-luna"
const TEST_CREATED = 1_760_000_000

type RecordedRequest = {
  readonly id: string
  readonly kind: "contestant" | "title" | "utility"
  readonly model: string
  readonly reasoningEffort?: string
  readonly latestUserText?: string
  readonly assignmentID?: string
  readonly scopeID?: string
  readonly generationID?: string
  readonly pending: boolean
}

type PendingResponse = {
  readonly request: RecordedRequest
  readonly response: Response
  readonly resolve: (response: Response) => void
  readonly reject: (error: unknown) => void
}

export type BrowserControlPlaneState = {
  readonly requests: readonly RecordedRequest[]
  readonly pendingRequestIDs: readonly string[]
  readonly failNextRating: boolean
}

export type BrowserControlPlane = {
  readonly url: string
  readonly port: number
  readonly state: () => BrowserControlPlaneState
  readonly close: () => Promise<void>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((part) => {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string") return []
    return [part.text]
  })
  return parts.length > 0 ? parts.join("") : undefined
}

function latestUserText(body: Record<string, unknown>) {
  if (!Array.isArray(body.messages)) return undefined
  for (const message of body.messages.toReversed()) {
    if (!record(message) || message.role !== "user") continue
    return text(message.content)
  }
  return undefined
}

function isTitleRequest(body: Record<string, unknown>) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some(
    (message) =>
      record(message) &&
      message.role === "user" &&
      text(message.content)?.trimStart().startsWith("Generate a title for this conversation:"),
  )
}

function jsonBody(request: Request) {
  return request
    .json()
    .then((value) => (record(value) ? value : {}))
    .catch(() => ({}) as Record<string, unknown>)
}

function responseBody(model: string) {
  return {
    id: "browser-control-plane-utility",
    object: "chat.completion",
    created: TEST_CREATED,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: "Deterministic utility result." }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  }
}

function streamBody(model: string, requestID: string) {
  const chunks = [
    {
      id: `chatcmpl-${requestID}`,
      object: "chat.completion.chunk",
      created: TEST_CREATED,
      model,
      choices: [
        { index: 0, delta: { role: "assistant", content: "Deterministic contestant result." }, finish_reason: null },
      ],
    },
    {
      id: `chatcmpl-${requestID}`,
      object: "chat.completion.chunk",
      created: TEST_CREATED,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
    },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`
}

function isContestantModel(model: unknown): model is string {
  return model === MEDIUM_SLUG || defaultPool.some((profile) => profile.slug === model)
}

function requestID(sequence: number) {
  return `browser-request-${sequence}`
}

export async function createBrowserControlPlane(): Promise<BrowserControlPlane> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-duel-browser-control-plane-"))
  const store = await connectLocalStore({ directory })
  const requests: RecordedRequest[] = []
  const pending = new Map<string, PendingResponse>()
  let sequence = 0
  let assignmentSequence = 0
  let failNextRating = false
  let closed = false

  const upstream: Fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json().catch(() => ({}))
    const payload = record(body) ? body : {}
    const model = typeof payload.model === "string" ? payload.model : "unknown"
    const id = requestID(++sequence)
    const kind: RecordedRequest["kind"] = isTitleRequest(payload)
      ? "title"
      : isContestantModel(model)
        ? "contestant"
        : "utility"
    const incomingHeaders = new Headers(init?.headers)
    const recorded: RecordedRequest = {
      id,
      kind,
      model,
      ...(record(payload.reasoning) && typeof payload.reasoning.effort === "string"
        ? { reasoningEffort: payload.reasoning.effort }
        : {}),
      ...(latestUserText(payload) ? { latestUserText: latestUserText(payload) } : {}),
      ...(incomingHeaders.get("x-arena-assignment-id")
        ? { assignmentID: incomingHeaders.get("x-arena-assignment-id")! }
        : {}),
      ...(incomingHeaders.get("x-arena-scope-id") ? { scopeID: incomingHeaders.get("x-arena-scope-id")! } : {}),
      ...(incomingHeaders.get("x-arena-generation-id")
        ? { generationID: incomingHeaders.get("x-arena-generation-id")! }
        : {}),
      pending: kind === "contestant",
    }
    requests.push(recorded)

    if (kind !== "contestant") {
      return payload.stream === true
        ? new Response(streamBody(model, id), { headers: { "content-type": "text/event-stream" } })
        : Response.json(responseBody(model))
    }

    const stream = payload.stream !== false
    const response = stream
      ? new Response(streamBody(model, id), { headers: { "content-type": "text/event-stream" } })
      : Response.json(responseBody(model))
    return await new Promise<Response>((resolve, reject) => {
      pending.set(id, { request: recorded, response, resolve, reject })
    })
  }

  const service = createArenaService({
    resolveCaller: async () => ({ id: TEST_USER_ID }),
    db: async () => store.db,
    pool: defaultPool,
    openRouterApiKey: "browser-control-plane-key",
    validateModels: async () => undefined,
    fetch: upstream,
    random: () => 0,
    uuid: () => `browser-assignment-${++assignmentSequence}`,
  })

  const state = (): BrowserControlPlaneState => ({
    requests: requests.map((request) => ({ ...request, pending: pending.has(request.id) })),
    pendingRequestIDs: [...pending.keys()],
    failNextRating,
  })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/__test/state" && request.method === "GET") return Response.json(state())
      if (url.pathname === "/__test/release" && request.method === "POST") {
        const body = await jsonBody(request)
        const id = typeof body.id === "string" ? body.id : undefined
        const held = id ? pending.get(id) : undefined
        if (!held) return Response.json({ error: "request is not pending" }, { status: 404 })
        pending.delete(id)
        held.resolve(held.response)
        return Response.json({ released: id })
      }
      if (url.pathname === "/__test/fail-next-rating" && request.method === "POST") {
        failNextRating = true
        return Response.json({ failNextRating: true })
      }
      if (url.pathname === "/api/auth/methods" && request.method === "GET") {
        return Response.json({ enabled: true, methods: ["email"] })
      }
      if (url.pathname === "/api/research") return new Response(null, { status: 204 })
      if (url.pathname === "/api/arena/assignments" && request.method === "POST") {
        const body = await request
          .clone()
          .json()
          .catch(() => ({}))
        if (record(body) && body.action === "resolve" && failNextRating) {
          failNextRating = false
          return Response.json({ error: "deterministic rating failure" }, { status: 503 })
        }
      }
      return (await service.route(request)) ?? new Response("Not found", { status: 404 })
    },
  })

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    state,
    async close() {
      if (closed) return
      closed = true
      server.stop(true)
      for (const held of pending.values()) held.reject(new Error("browser control plane closed"))
      pending.clear()
      await store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

if (import.meta.main) {
  const controlPlane = await createBrowserControlPlane()
  process.stdout.write(`${JSON.stringify({ ready: true, port: controlPlane.port, url: controlPlane.url })}\n`)
  const close = async () => {
    await controlPlane.close()
    process.exit(0)
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}
