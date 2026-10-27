import { afterEach, describe, expect, jest, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { createArenaService, type ArenaServiceOptions } from "./service"
import { HEARTBEAT_HEADER, HEARTBEAT_LINE, HEARTBEAT_MS, REPLAY_PATH, REPLAY_UNAVAILABLE_LINE } from "./stream-recovery"

const generationID = "gen_0123456789abcdef0123456789abcdef"
const encoder = new TextEncoder()

const assignmentSet = {
  userId: "user-1",
  scopeID: "turn-1",
  assignments: [
    {
      assignmentID: "opaque-id",
      model: { displayName: "Hidden", slug: "provider/hidden", canonicalSlug: "provider/hidden", routing: {} },
    },
  ],
}

function memoryDb() {
  const replays = new Map<string, Record<string, unknown>>()
  const db = {
    collection: (name: string) => {
      if (name === "arenaAssignmentSets") {
        return {
          find: (filter: { userId: string; scopeID: string }) => ({
            toArray: async () =>
              filter.userId === assignmentSet.userId && filter.scopeID === assignmentSet.scopeID ? [assignmentSet] : [],
          }),
        }
      }
      if (name === "arenaAssignmentGenerationMetrics") {
        return { replaceOne: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }) }
      }
      if (name === "arenaGenerationReplays") {
        return {
          findOne: async (filter: { _id: string; userId: string }) => {
            const row = replays.get(filter._id)
            return row && row.userId === filter.userId ? row : null
          },
          replaceOne: async (filter: { _id: string }, document: Record<string, unknown>) => {
            replays.set(filter._id, document)
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
          },
        }
      }
      throw new Error(`Unexpected Arena collection: ${name}`)
    },
  } as unknown as ArenaDb
  return { db, replays: () => [...replays.values()] }
}

function service(options: Omit<Partial<ArenaServiceOptions>, "db"> & { readonly db: ArenaDb }) {
  const { db, ...rest } = options
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => db,
    pool: [],
    openRouterApiKey: "server-secret",
    fetch: async () => {
      throw new Error("OpenRouter must not be contacted")
    },
    ...rest,
  }).openrouter
}

function contestantRequest(path = "/api/v1/chat/completions", headers: Record<string, string> = {}) {
  return new Request(`https://control.test/api/openrouter${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arena-Assignment-ID": "opaque-id",
      "X-Arena-Scope-ID": "turn-1",
      "X-Arena-Generation-ID": generationID,
      ...headers,
    },
    body: JSON.stringify({ model: "contestant", messages: [], stream: true }),
  })
}

const content = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`

afterEach(() => {
  jest.useRealTimers()
})

describe("contestant stream recovery", () => {
  test("writes heartbeats into a quiet stream and records what it sent for replay", async () => {
    jest.useFakeTimers()
    const store = memoryDb()
    let finish!: () => void
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(content("thinking done")))
        await new Promise<void>((resolve) => (finish = resolve))
        controller.enqueue(encoder.encode(`${content("answer")}data: [DONE]\n\n`))
        controller.close()
      },
    })
    const proxy = service({
      db: store.db,
      fetch: async () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    })
    const response = await proxy(contestantRequest())
    expect(response.headers.get(HEARTBEAT_HEADER)).toBe(String(HEARTBEAT_MS))
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let sent = ""
    while (!sent.includes('thinking done"}}]}\n\n')) sent += decoder.decode((await reader.read()).value)
    jest.advanceTimersByTime(HEARTBEAT_MS + HEARTBEAT_MS / 4)
    expect(decoder.decode((await reader.read()).value)).toBe(`${HEARTBEAT_LINE}\n`)
    finish()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      sent += decoder.decode(next.value)
    }
    expect(sent).toContain("answer")
    expect(sent).not.toContain(HEARTBEAT_LINE)
    expect(store.replays()).toMatchObject([{ state: "complete", body: sent, userId: "user-1" }])
  })

  test("replays a recorded response only to its own account, scope, assignment and generation", async () => {
    const store = memoryDb()
    const proxy = service({
      db: store.db,
      fetch: async () =>
        new Response(`${content("recorded")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
    })
    const original = await (await proxy(contestantRequest())).text()

    const replay = await proxy(contestantRequest(REPLAY_PATH))
    expect(replay.status).toBe(200)
    expect(replay.headers.get("content-type")).toBe("text/event-stream")
    expect(await replay.text()).toBe(original)

    const otherGeneration = await proxy(
      contestantRequest(REPLAY_PATH, { "X-Arena-Generation-ID": "gen_ffffffffffffffffffffffffffffffff" }),
    )
    expect(otherGeneration.status).toBe(404)
    expect(await otherGeneration.text()).not.toContain("recorded")

    const otherAccount = service({ db: store.db, resolveCaller: async () => ({ id: "user-2" }) })
    expect((await otherAccount(contestantRequest(REPLAY_PATH))).status).toBe(403)

    const otherScope = await proxy(contestantRequest(REPLAY_PATH, { "X-Arena-Scope-ID": "turn-2" }))
    expect(otherScope.status).toBe(403)

    const noGeneration = await proxy(contestantRequest(REPLAY_PATH, { "X-Arena-Generation-ID": "" }))
    expect(noGeneration.status).toBe(400)
  })

  test("waits for a response that is still streaming, then replays it", async () => {
    const store = memoryDb()
    let finish!: () => void
    const proxy = service({
      db: store.db,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(content("first")))
              await new Promise<void>((resolve) => (finish = resolve))
              controller.enqueue(encoder.encode(`${content("second")}data: [DONE]\n\n`))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    // The desktop stopped reading; the function keeps sending into the dead connection.
    const original = proxy(contestantRequest()).then((response) => response.text())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const replay = proxy(contestantRequest(REPLAY_PATH))
    setTimeout(() => finish(), 300)
    const replayed = await (await replay).text()
    expect(replayed).toBe(await original)
    expect(replayed).toContain("second")
  })

  test("ends a waiting replay as unavailable when the original stream fails", async () => {
    const store = memoryDb()
    let fail!: () => void
    const proxy = service({
      db: store.db,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(content("first")))
              await new Promise<void>((resolve) => (fail = resolve))
              controller.error(new Error("private upstream failure"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const original = proxy(contestantRequest()).then((response) => response.text())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const replay = proxy(contestantRequest(REPLAY_PATH))
    setTimeout(() => fail(), 300)
    expect(await (await replay).text()).toBe(`${REPLAY_UNAVAILABLE_LINE}\n`)
    expect(await original).toContain("arena_retryable_stream_error")
    expect(store.replays()).toMatchObject([{ state: "failed" }])
  })

  test("sends no heartbeats and keeps no replay where the service runs on the user's machine", async () => {
    const store = memoryDb()
    const proxy = service({
      db: store.db,
      streamRecovery: false,
      fetch: async () =>
        new Response(`${content("local")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
    })
    const response = await proxy(contestantRequest())
    expect(response.headers.get(HEARTBEAT_HEADER)).toBeNull()
    await response.text()
    expect(store.replays()).toEqual([])
    expect((await proxy(contestantRequest(REPLAY_PATH))).status).toBe(400)
  })
})
