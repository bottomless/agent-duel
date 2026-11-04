import { describe, expect, spyOn, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { loadGenerationCapture, splitRequest } from "./generation-capture"
import { createArenaService, type ArenaServiceOptions } from "./service"

const generationID = "gen_0123456789abcdef0123456789abcdef"
const encoder = new TextEncoder()
const png = Buffer.from("not really a png, but bytes all the same").toString("base64")

const model = {
  displayName: "Hidden",
  slug: "provider/hidden",
  canonicalSlug: "provider/hidden",
  contextWindow: 200_000,
  routing: { sort: "throughput" },
}

type Row = Record<string, unknown> & { _id: string }

function matches(row: Row, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected.$in as unknown[]).includes(row[key])
    }
    return row[key] === expected
  })
}

/** Keeps every collection the proxy writes in memory. `single` makes the assignment a single-agent one. */
function memoryDb(input: { readonly single?: boolean; readonly failCaptures?: boolean } = {}) {
  const collections = new Map<string, Map<string, Row>>()
  const rows = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)!
  }
  const assignmentSet = {
    userId: "user-1",
    scopeID: "turn-1",
    assignments: [{ assignmentID: "opaque-id", model, ...(input.single ? { modelSize: "frontier" } : {}) }],
  }
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
      const fail = input.failCaptures && name.startsWith("arenaGeneration")
      return {
        find: (filter: Record<string, unknown>) => ({
          toArray: async () => {
            if (fail) throw new Error("store is down")
            return [...rows(name).values()].filter((row) => matches(row, filter))
          },
        }),
        findOne: async (filter: Record<string, unknown>) =>
          [...rows(name).values()].find((row) => matches(row, filter)) ?? null,
        insertOne: async (document: Row) => {
          if (fail) throw new Error("store is down")
          if (rows(name).has(document._id)) throw Object.assign(new Error("duplicate"), { code: 11000 })
          rows(name).set(document._id, document)
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
        },
        replaceOne: async (filter: { _id: string }, document: Row) => {
          if (fail) throw new Error("store is down")
          rows(name).set(filter._id, document)
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
        },
        updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
          if (fail) throw new Error("store is down")
          const row = [...rows(name).values()].find((candidate) => matches(candidate, filter))
          if (row) Object.assign(row, update.$set)
          return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 }
        },
      }
    },
  } as unknown as ArenaDb
  return { db, rows: (name: string) => [...rows(name).values()] }
}

function proxy(db: ArenaDb, fetch: ArenaServiceOptions["fetch"], options: Partial<ArenaServiceOptions> = {}) {
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => db,
    pool: [],
    openRouterApiKey: "server-secret",
    fetch,
    streamRecovery: false,
    captureGenerations: true,
    ...options,
  }).openrouter
}

function contestantRequest(messages: unknown[], id = generationID) {
  return new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arena-Assignment-ID": "opaque-id",
      "X-Arena-Scope-ID": "turn-1",
      "X-Arena-Generation-ID": id,
    },
    body: JSON.stringify({
      model: "contestant",
      messages,
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      stream: true,
    }),
  })
}

const upstreamStream = [
  `data: ${JSON.stringify({ id: "gen-real", model: "provider/hidden", provider: "Real Cloud", choices: [{ index: 0, delta: { content: "hi", tool_calls: [{ id: "toolu_vrtx_01", type: "function" }] } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "gen-real", usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 } })}\n\n`,
  "data: [DONE]\n\n",
]

/** Answers with the stream above in fragments and remembers each body it was sent. */
function recordingFetch(sent: string[]) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(new TextDecoder().decode(init!.body as ArrayBuffer))
    const text = upstreamStream.join("")
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Cut mid-line, as a network does.
          controller.enqueue(encoder.encode(text.slice(0, 37)))
          controller.enqueue(encoder.encode(text.slice(37)))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
}

describe("generation capture", () => {
  test("keeps the body OpenRouter received and its raw response, and shares parts across calls", async () => {
    const store = memoryDb()
    const sent: string[] = []
    const send = proxy(store.db, recordingFetch(sent))
    const first = [
      { role: "system", content: "You are a coding agent." },
      {
        role: "user",
        content: [
          { type: "text", text: "Fix this" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
        ],
      },
    ]
    const delivered = await (await send(contestantRequest(first))).text()
    // The voter's copy is scrubbed; the capture keeps what the provider sent.
    expect(delivered).not.toContain("Real Cloud")

    const loaded = await loadGenerationCapture(store.db, "user-1", generationID)
    expect(loaded?.verified).toBe(true)
    expect(JSON.stringify(loaded!.body)).toBe(sent[0]!)
    expect(loaded!.body).toMatchObject({ model: "provider/hidden", provider: { sort: "throughput" } })
    expect(loaded!.capture).toMatchObject({
      userId: "user-1",
      scopeID: "turn-1",
      assignmentID: "opaque-id",
      generationID,
      model: "provider/hidden",
      endpoint: "chat",
      response: { state: "complete", status: 200, body: upstreamStream.join("") },
    })
    expect(loaded!.capture.request.media).toHaveLength(1)
    const firstParts = store.rows("arenaGenerationParts").length

    const second = "gen_fedcba9876543210fedcba9876543210"
    await (await send(contestantRequest([...first, { role: "assistant", content: "Done." }], second))).text()
    const again = await loadGenerationCapture(store.db, "user-1", second)
    expect(again?.verified).toBe(true)
    expect(JSON.stringify(again!.body)).toBe(sent[1]!)
    // Params differ by nothing but the new message, so only that message is new.
    expect(store.rows("arenaGenerationParts")).toHaveLength(firstParts + 1)
    expect(await loadGenerationCapture(store.db, "user-2", second)).toBeUndefined()
  })

  test("keeps a refusal's status and text", async () => {
    const store = memoryDb()
    spyOn(console, "error").mockImplementation(() => undefined)
    const send = proxy(store.db, async () => new Response('{"error":{"message":"No endpoints"}}', { status: 404 }))
    expect((await send(contestantRequest([{ role: "user", content: "hi" }]))).status).toBe(404)
    expect((await loadGenerationCapture(store.db, "user-1", generationID))?.capture.response).toMatchObject({
      state: "failed",
      status: 404,
      body: '{"error":{"message":"No endpoints"}}',
    })
  })

  test("keeps a JSON response", async () => {
    const store = memoryDb()
    const raw = JSON.stringify({ id: "gen-real", provider: "Real Cloud", choices: [{ message: { content: "ok" } }] })
    const send = proxy(store.db, async () => new Response(raw, { headers: { "content-type": "application/json" } }))
    expect((await send(contestantRequest([{ role: "user", content: "hi" }]))).status).toBe(200)
    expect((await loadGenerationCapture(store.db, "user-1", generationID))?.capture.response).toMatchObject({
      state: "complete",
      body: raw,
    })
  })

  test("skips single-agent chats and services that leave it off", async () => {
    const single = memoryDb({ single: true })
    await (await proxy(single.db, recordingFetch([]))(contestantRequest([{ role: "user", content: "hi" }]))).text()
    expect(single.rows("arenaGenerationCaptures")).toHaveLength(0)
    expect(single.rows("arenaGenerationParts")).toHaveLength(0)

    const off = memoryDb()
    const send = proxy(off.db, recordingFetch([]), { captureGenerations: undefined })
    await (await send(contestantRequest([{ role: "user", content: "hi" }]))).text()
    expect(off.rows("arenaGenerationCaptures")).toHaveLength(0)
  })

  test("answers the call when the store fails", async () => {
    const store = memoryDb({ failCaptures: true })
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    const response = await proxy(store.db, recordingFetch([]))(contestantRequest([{ role: "user", content: "hi" }]))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"hi"')
    expect(errors).toHaveBeenCalledWith("[arena-service] Arena generation capture could not be stored")
    errors.mockRestore()
  })

  test("leaves media that would not re-encode exactly inside its message", () => {
    const split = splitRequest({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ" } }] }],
    })
    expect(split.media).toHaveLength(0)
    expect(split.components.at(-1)?.text).toContain("data:image/png;base64,QQ")
  })
})
