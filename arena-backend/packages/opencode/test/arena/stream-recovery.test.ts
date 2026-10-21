import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"
import { AssignmentRegistry, proxy, streamProgress } from "../../src/arena/proxy"
import { createArenaService } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { HEARTBEAT_HEADER, REPLAY_PATH, REPLAY_UNAVAILABLE_LINE } from "@agent-duel/arena-service/stream-recovery"

const assignment = {
  runID: "run-a",
  rootSessionID: "session-root",
  scopeID: "turn-a",
  assignmentID: "opaque-assignment",
  telemetry: true,
} as const

const requestID = "00000000-0000-4000-8000-000000000001"
const encoder = new TextEncoder()

const assignmentSet = {
  userId: "user-1",
  scopeID: "turn-a",
  assignments: [
    {
      assignmentID: "opaque-assignment",
      model: {
        displayName: "Hidden Model",
        slug: "provider/hidden-model",
        canonicalSlug: "provider/hidden-model-version",
        routing: { sort: "throughput" },
      },
    },
  ],
}

/** The three collections the proxy touches, kept in memory. */
function memoryDb() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const table = (name: string) => {
    let rows = tables.get(name)
    if (!rows) tables.set(name, (rows = new Map()))
    return rows
  }
  const db = {
    collection: (name: string) => ({
      find: () => ({
        toArray: async () => (name === "arenaAssignmentSets" ? [assignmentSet] : [...table(name).values()]),
      }),
      findOne: async (filter: { _id: string }) => table(name).get(filter._id) ?? null,
      replaceOne: async (filter: { _id: string }, document: Record<string, unknown>) => {
        table(name).set(filter._id, document)
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
      deleteMany: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, deletedCount: 0 }),
    }),
  } as unknown as ArenaDb
  return { db, replays: () => [...table("arenaGenerationReplays").values()] }
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const content = (text: string) => event({ choices: [{ index: 0, delta: { content: text } }] })
const finish = event({
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
})

/** OpenRouter answering in parts, with a pause after the first so the connection can die mid-answer. */
function openRouterAnswer(rest: Promise<void>) {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(content("Hel")))
        await rest
        controller.enqueue(encoder.encode(content("lo")))
        controller.enqueue(encoder.encode(content(" world")))
        controller.enqueue(encoder.encode(finish))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

/**
 * A connection that dies silently after its first event: the control plane keeps writing, as the
 * hosted function did, and the desktop never sees another byte or a close.
 */
function dyingConnection(response: Response, heartbeatMs: string) {
  const source = response.body!.getReader()
  let first = true
  const drained = async () => {
    for (;;) if ((await source.read()).done) return
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!first) {
        void drained()
        return new Promise<void>(() => {})
      }
      first = false
      const next = await source.read()
      if (!next.done) controller.enqueue(next.value)
    },
  })
  const headers = new Headers(response.headers)
  // The real heartbeat period would make the desktop wait 30 seconds; the protocol is the same.
  headers.set(HEARTBEAT_HEADER, heartbeatMs)
  return new Response(body, { status: response.status, headers })
}

function arenaRequest(body?: BodyInit | null, signal?: AbortSignal) {
  return new Request("http://localhost/arena/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": "session-root", "x-arena-request-id": requestID },
    body: body ?? JSON.stringify({ model: "contestant", messages: [], stream: true }),
    signal,
  })
}

async function answerOf(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const model = createOpenRouter({ apiKey: "test-key", fetch }).chat("contestant")
  const result = streamText({ model, prompt: "test", maxRetries: 0 })
  let answer = ""
  let error: unknown
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") answer += part.text
    if (part.type === "error") error = part.error
  }
  return { answer, error }
}

describe("contestant stream recovery", () => {
  test("replays a response whose connection died, without repeating what the model call received", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const store = memoryDb()
    let releaseRest!: () => void
    const rest = new Promise<void>((resolve) => (releaseRest = resolve))
    let openRouterCalls = 0
    const service = createArenaService({
      resolveCaller: async () => ({ id: "user-1" }),
      db: async () => store.db,
      pool: [],
      openRouterApiKey: "server-secret",
      fetch: async () => {
        openRouterCalls++
        return openRouterAnswer(rest)
      },
    })
    const paths: string[] = []
    const { answer, error } = await answerOf((_input, init) =>
      proxy(arenaRequest(init?.body), registry, {
        upstream: "https://control.test/api/openrouter",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname
          paths.push(path)
          const response = await service.openrouter(new Request(input, init))
          if (path.endsWith(REPLAY_PATH)) return response
          // The answer finishes upstream only after the desktop has given up on the connection.
          setTimeout(releaseRest, 200)
          return dyingConnection(response, "20")
        },
      }),
    )

    expect(error).toBeUndefined()
    expect(answer).toBe("Hello world")
    expect(openRouterCalls).toBe(1)
    expect(paths).toEqual(["/api/openrouter/api/v1/chat/completions", `/api/openrouter${REPLAY_PATH}`])
    expect(store.replays()).toMatchObject([{ state: "complete" }])
    const progress = streamProgress("session-root")
    expect(progress?.replayedMsAgo).toBeGreaterThanOrEqual(0)
    expect(progress?.failure).toBeUndefined()
  })

  test("fails a dead stream as retryable when nothing was recorded", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    for (const replay of [
      () => Response.json({ error: { type: "arena_replay_unavailable" } }, { status: 404 }),
      () =>
        new Response(`${REPLAY_UNAVAILABLE_LINE}\n`, {
          headers: { "content-type": "text/event-stream", [HEARTBEAT_HEADER]: "20" },
        }),
      // The replay's own connection dies too.
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }), {
          headers: { "content-type": "text/event-stream", [HEARTBEAT_HEADER]: "20" },
        }),
    ]) {
      const response = await proxy(arenaRequest(), registry, {
        upstream: "https://control.test/api/openrouter",
        fetch: async (input) => {
          if (String(input).endsWith(REPLAY_PATH)) return replay()
          return dyingConnection(
            new Response(content("Hel"), { headers: { "content-type": "text/event-stream" } }),
            "20",
          )
        },
      })
      const text = await response.text()
      expect(text).toContain("Hel")
      expect(text).toContain('"message":"Arena contestant stream failed"')
      expect(text).toContain('"code":"server_error"')
      expect(streamProgress("session-root")?.failure).toMatch(/^(stalled|replay-unavailable)$/)
    }
  })

  test("does not give up on a quiet stream when the control plane sends no heartbeats", async () => {
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    let releaseRest!: () => void
    const rest = new Promise<void>((resolve) => (releaseRest = resolve))
    setTimeout(releaseRest, 150)
    const replays: string[] = []
    const { answer, error } = await answerOf((_input, init) =>
      proxy(arenaRequest(init?.body), registry, {
        upstream: "https://control.test/api/openrouter",
        fetch: async (input) => {
          if (String(input).endsWith(REPLAY_PATH)) replays.push(String(input))
          return openRouterAnswer(rest)
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(answer).toBe("Hello world")
    expect(replays).toEqual([])
  })
})
