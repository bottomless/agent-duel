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

const gemini = { ...model, slug: "google/gemini-4-carbon" }
const geminiRefusal = JSON.stringify({
  error: {
    code: 400,
    metadata: {
      provider_name: "Google AI Studio",
      raw: JSON.stringify({
        error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
      }),
    },
  },
})

type Row = Record<string, unknown> & { _id: string }

function matches(row: Row, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected.$in as unknown[]).includes(row[key])
    }
    return row[key] === expected
  })
}

/** Keeps every collection the proxy writes in memory. `modelSize` makes the assignment a single-agent one. */
function memoryDb(
  input: {
    readonly modelSize?: "medium" | "frontier"
    readonly scopeID?: string
    readonly failCaptures?: boolean
    readonly model?: typeof model
  } = {},
) {
  const collections = new Map<string, Map<string, Row>>()
  const rows = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)!
  }
  const assignmentSet = {
    userId: "user-1",
    scopeID: input.scopeID ?? "turn-1",
    assignments: [
      {
        assignmentID: "opaque-id",
        model: input.model ?? model,
        ...(input.modelSize ? { modelSize: input.modelSize } : {}),
      },
    ],
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

function contestantRequest(messages: unknown[], id = generationID, scopeID = "turn-1", model = "contestant") {
  return new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arena-Assignment-ID": "opaque-id",
      "X-Arena-Scope-ID": scopeID,
      "X-Arena-Generation-ID": id,
    },
    body: JSON.stringify({
      model,
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
  test("captures both the refused Gemini request and the successful tool-result retry", async () => {
    const store = memoryDb({ model: gemini })
    const sent: string[] = []
    const refusal = geminiRefusal
    const messages = [
      { role: "user", content: "Inspect the report" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
        reasoning_details: [
          { type: "reasoning.encrypted", data: "opaque-signature", format: "google-gemini-v1", id: "call-1" },
        ],
      },
      { role: "tool", tool_call_id: "call-1", name: "read", content: "Report output\r\nwith plain text" },
    ]
    const reply = recordingFetch(sent)
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const send = proxy(store.db, async (input, init) => {
        if (sent.length > 0) return reply(input, init)
        sent.push(await new Response(init?.body).text())
        return new Response(refusal, { status: 400 })
      })
      const response = await send(contestantRequest(messages))
      expect(response.status).toBe(200)
      const delivered = await response.text()
      expect(delivered).toContain("[DONE]")
      expect(delivered).not.toContain("Google AI Studio")
      expect(sent).toHaveLength(2)
      const first = JSON.parse(sent[0]!)
      const second = JSON.parse(sent[1]!)
      expect(first.messages).toEqual(messages)
      expect(second).toEqual({
        ...first,
        messages: [
          ...messages.slice(0, -1),
          {
            ...messages.at(-1),
            content: JSON.stringify({ output: messages.at(-1)!.content }),
          },
        ],
      })
      const final = await loadGenerationCapture(store.db, "user-1", generationID)
      expect(final?.verified).toBe(true)
      expect(JSON.stringify(final!.body)).toBe(sent[1]!)
      expect(final!.capture.response).toMatchObject({ state: "complete", status: 200, body: upstreamStream.join("") })
      const captures = store.rows("arenaGenerationCaptures")
      expect(captures).toHaveLength(2)
      const refused = captures.find((row) => row.generationID !== generationID)!
      expect(refused.retriedByGenerationID).toBe(generationID)
      const original = await loadGenerationCapture(store.db, "user-1", String(refused.generationID))
      expect(original?.verified).toBe(true)
      expect(JSON.stringify(original!.body)).toBe(sent[0]!)
      expect(original!.capture.response).toMatchObject({ state: "failed", status: 400, body: refusal })
    } finally {
      errors.mockRestore()
    }
  })

  test.each([400, 429, 500])("stops after one retry and captures its %i refusal", async (status) => {
    const store = memoryDb({ model: gemini })
    let calls = 0
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const send = proxy(store.db, async () => {
        calls++
        return new Response(geminiRefusal, { status: calls === 1 ? 400 : status })
      })
      const response = await send(contestantRequest([{ role: "tool", tool_call_id: "call-1", content: "output" }]))
      expect(calls).toBe(2)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({
        error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
      })
      const loaded = await loadGenerationCapture(store.db, "user-1", generationID)
      expect(loaded?.verified).toBe(true)
      expect(loaded!.body.messages).toEqual([{ role: "tool", tool_call_id: "call-1", content: '{"output":"output"}' }])
      expect(loaded!.capture.response).toMatchObject({ state: "failed", status, body: geminiRefusal })
      expect(store.rows("arenaGenerationCaptures")).toHaveLength(2)
    } finally {
      errors.mockRestore()
    }
  })

  test("closes a retry capture when its fetch rejects, without inheriting the first status", async () => {
    const store = memoryDb({ model: gemini })
    let calls = 0
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const send = proxy(store.db, async () => {
        calls++
        if (calls === 1) return new Response(geminiRefusal, { status: 400 })
        throw new Error("network unavailable")
      })
      const response = await send(contestantRequest([{ role: "tool", content: "output" }]))
      expect(calls).toBe(2)
      expect(response.status).toBe(502)
      const loaded = await loadGenerationCapture(store.db, "user-1", generationID)
      expect(loaded?.verified).toBe(true)
      expect(loaded!.capture.response).toMatchObject({ state: "failed", body: "" })
      expect(loaded!.capture.response?.status).toBeUndefined()
    } finally {
      errors.mockRestore()
    }
  })

  test("does not retry a cancelled request", async () => {
    const store = memoryDb({ model: gemini })
    const controller = new AbortController()
    let calls = 0
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const send = proxy(store.db, async () => {
        calls++
        controller.abort()
        return new Response(geminiRefusal, { status: 400 })
      })
      const request = new Request(contestantRequest([{ role: "tool", content: "output" }]), {
        signal: controller.signal,
      })
      expect((await send(request)).status).toBe(400)
      expect(calls).toBe(1)
      expect(store.rows("arenaGenerationCaptures")).toHaveLength(1)
    } finally {
      errors.mockRestore()
    }
  })

  test("can retry with capture disabled and keeps the upstream authentication and abort signal", async () => {
    const store = memoryDb({ model: gemini })
    const sent: string[] = []
    const options: (RequestInit | undefined)[] = []
    const reply = recordingFetch(sent)
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const send = proxy(
        store.db,
        async (input, init) => {
          options.push(init)
          if (options.length > 1) return reply(input, init)
          return new Response(geminiRefusal, { status: 400 })
        },
        { captureGenerations: false },
      )
      const response = await send(contestantRequest([{ role: "tool", content: "output" }]))
      await response.text()
      expect(response.status).toBe(200)
      expect(options).toHaveLength(2)
      expect(options[1]!.signal).toBe(options[0]!.signal)
      expect(options[1]!.headers).toEqual(options[0]!.headers)
      expect(new Headers(options[1]!.headers).get("authorization")).toBe("Bearer server-secret")
      expect(store.rows("arenaGenerationCaptures")).toHaveLength(0)
    } finally {
      errors.mockRestore()
    }
  })

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

  test.each(["medium", "frontier"] as const)(
    "captures a %s single-agent turn under its rating's scope, sharing parts across calls",
    async (modelSize) => {
      const sessionID = "ses_single"
      const messageID = "msg_prompt"
      const ratingID = `single-agent|${sessionID.length}:${sessionID}|${messageID.length}:${messageID}`
      const store = memoryDb({ modelSize, scopeID: ratingID })
      const sent: string[] = []
      const send = proxy(store.db, recordingFetch(sent))
      const model = modelSize === "medium" ? "medium" : "contestant"
      const first = [{ role: "user", content: "Fix this" }]
      await (await send(contestantRequest(first, generationID, ratingID, model))).text()
      const loaded = await loadGenerationCapture(store.db, "user-1", generationID)
      expect(loaded?.verified).toBe(true)
      expect(JSON.stringify(loaded!.body)).toBe(sent[0]!)
      expect(loaded!.capture).toMatchObject({ scopeID: ratingID, assignmentID: "opaque-id" })
      expect(loaded!.capture.response).toMatchObject({ state: "complete", status: 200 })
      const firstParts = store.rows("arenaGenerationParts").length

      const second = "gen_fedcba9876543210fedcba9876543210"
      await (
        await send(contestantRequest([...first, { role: "assistant", content: "Done." }], second, ratingID, model))
      ).text()
      expect(store.rows("arenaGenerationCaptures")).toHaveLength(2)
      // The follow-up resends the history; only its new message is a new part.
      expect(store.rows("arenaGenerationParts")).toHaveLength(firstParts + 1)
    },
  )

  test("skips capture on services that leave it off", async () => {
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
