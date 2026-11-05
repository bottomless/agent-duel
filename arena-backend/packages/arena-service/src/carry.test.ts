import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import {
  assembleChatCompletion,
  HANDOFF_HEADINGS,
  HANDOFF_REQUEST,
  MAX_NOTE_CHARS,
  NOTHING_TO_CARRY,
  validateHandoff,
  warmWindowMs,
} from "./carry"
import type { ArenaDb } from "./collection"
import { generationCapture } from "./generation-capture"
import { createArenaService, type ArenaServiceOptions } from "./service"

const generationID = "gen_0123456789abcdef0123456789abcdef"
const userId = "user-1"
const scopeID = "turn|38:chat|30:ses_0123456789abcdef0123456789|1:0"

const deepseek = {
  displayName: "DeepSeek V4.1 Flash (A)",
  slug: "deepseek/deepseek-v4.1-flash-1017",
  canonicalSlug: "deepseek/deepseek-v4.1-flash-20261017",
  contextWindow: 1_048_576,
  routing: { sort: "throughput", require_parameters: true },
}
const claude = { ...deepseek, displayName: "Claude Opus 5.5", slug: "anthropic/claude-opus-5.5" }

type Row = Record<string, unknown> & { _id: string }

function matches(row: Row, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected.$in as unknown[]).includes(row[key])
    }
    return row[key] === expected
  })
}

function memoryDb() {
  const collections = new Map<string, Map<string, Row>>()
  const rows = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)!
  }
  const db = {
    collection: (name: string) => ({
      find: (filter: Record<string, unknown>) => ({
        toArray: async () => [...rows(name).values()].filter((row) => matches(row, filter)),
      }),
      findOne: async (filter: Record<string, unknown>) =>
        [...rows(name).values()].find((row) => matches(row, filter)) ?? null,
      insertOne: async (document: Row) => {
        if (rows(name).has(document._id)) throw Object.assign(new Error("duplicate"), { code: 11000 })
        rows(name).set(document._id, structuredClone(document))
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
      },
      replaceOne: async (filter: { _id: string }, document: Row) => {
        rows(name).set(filter._id, structuredClone(document))
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
      updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
        const row = [...rows(name).values()].find((candidate) => matches(candidate, filter))
        if (row) Object.assign(row, update.$set)
        return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 }
      },
    }),
  } as unknown as ArenaDb
  return { db, rows: (name: string) => [...rows(name).values()] }
}

function setID(kind: "battle" | "single") {
  return createHash("sha256").update(`${userId.length}:${userId}|${kind}|${scopeID}`).digest("hex")
}

const capturedBody = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  messages: [
    { role: "system", content: "You are a contestant." },
    { role: "user", content: "Add a retry to the uploader." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "export function upload() {}" },
  ],
  tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  reasoning: { effort: "high" },
  provider: { sort: "throughput", require_parameters: true },
  session_id: "opaque-id",
  prompt_cache_key: "opaque-id",
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 32_000,
}

const sse = (chunks: unknown[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"

const finalReply = sse([
  {
    id: "gen-1",
    provider: "Together",
    choices: [
      {
        index: 0,
        delta: {
          reasoning: "Check the uploader ",
          reasoning_details: [{ type: "reasoning.text", text: "Check the uploader " }],
        },
      },
    ],
  },
  {
    id: "gen-1",
    choices: [
      {
        index: 0,
        delta: {
          reasoning: "first.",
          reasoning_details: [{ type: "reasoning.text", text: "first.", format: "deepseek-v1" }],
        },
      },
    ],
  },
  { id: "gen-1", choices: [{ index: 0, delta: { content: "Added a retry with backoff in src/upload.ts." } }] },
  { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "gen-1", usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0001 } },
])

const scratch = [
  "## Scratch",
  '- Retry inside src/upload.ts — shown above: "retry with backoff in src/upload.ts"',
  "- A retry wrapper per caller — shown above: nowhere",
  "",
].join("\n")
const draftText = [
  "## Why",
  "- retry inside src/upload.ts rather than at call sites: one place to tune",
  "",
  "## Set aside",
  "- a retry wrapper per caller: duplicated the backoff three times",
  "",
  "## Assumed",
  "- the server returns 503 on overload; not verified against the API docs",
  "",
  "## Unsure",
  "- the backoff cap of 8 s is a guess",
].join("\n")

async function storeCapture(db: ArenaDb, model = deepseek.slug, createdAt = new Date()) {
  const capture = generationCapture(
    db,
    { userId, scopeID, assignmentID: "winner-id", generationID, model, endpoint: "chat" },
    () => createdAt,
  )
  await capture.request(JSON.stringify(capturedBody))
  capture.record(finalReply)
  await capture.finish("complete", 200)
}

async function storeSet(db: ArenaDb, decision: string | undefined, model = deepseek) {
  await db.collection<Row>("arenaAssignmentSets").insertOne({
    _id: setID("battle"),
    userId,
    scopeID,
    kind: "battle",
    assignments: [
      { assignmentID: "winner-id", model },
      { assignmentID: "loser-id", model: { ...model, displayName: "DeepSeek V4.1 Flash (B)" } },
    ],
    createdAt: new Date(),
    ...(decision ? { decision } : {}),
  })
}

function service(db: ArenaDb, fetch: ArenaServiceOptions["fetch"], options: Partial<ArenaServiceOptions> = {}) {
  return createArenaService({
    resolveCaller: async () => ({ id: userId }),
    db: async () => db,
    pool: [deepseek, claude],
    openRouterApiKey: "server-secret",
    fetch,
    streamRecovery: false,
    captureGenerations: true,
    carry: true,
    ...options,
  })
}

function carryRequest(body: Record<string, unknown> = {}) {
  return new Request("https://control.test/api/arena/carry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "carry", kind: "battle", scopeID, decision: "select:a", generationID, ...body }),
  })
}

/** Answers each call with the next content; the last one repeats. */
function replyingFetch(sent: Record<string, unknown>[], contents: string[] = [scratch + draftText]) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const content = contents[Math.min(sent.length - 1, contents.length - 1)]!
    return new Response(
      sse([
        { id: "gen-2", provider: "Together", choices: [{ index: 0, delta: { reasoning: "Check." } }] },
        { id: "gen-2", choices: [{ index: 0, delta: { content } }] },
        { id: "gen-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "gen-2", usage: { prompt_tokens: 200, completion_tokens: 80 } },
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }
}

describe("assembleChatCompletion", () => {
  test("rebuilds a streamed reply with the SDK's detail merge", () => {
    const reply = assembleChatCompletion(finalReply)
    expect(reply.content).toBe("Added a retry with backoff in src/upload.ts.")
    expect(reply.reasoning).toBe("Check the uploader first.")
    expect(reply.reasoningDetails).toEqual([
      { type: "reasoning.text", text: "Check the uploader first.", format: "deepseek-v1" },
    ])
    expect(reply.finishReason).toBe("stop")
    expect(reply.provider).toBe("Together")
    expect(reply.usage).toEqual({ prompt_tokens: 120, completion_tokens: 30, cost: 0.0001 })
    expect(reply.toolCalls).toBe(false)
  })

  test("reads a non-streamed reply and keeps separate detail blocks apart", () => {
    const reply = assembleChatCompletion(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "done",
              reasoning_details: [
                { type: "reasoning.text", text: "a", signature: "sig-a" },
                { type: "reasoning.text", text: "b", signature: "sig-b" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      }),
    )
    expect(reply.reasoningDetails).toHaveLength(2)
    expect(reply.content).toBe("done")
  })

  test("flags tool calls and upstream errors", () => {
    expect(assembleChatCompletion(sse([{ choices: [{ delta: { tool_calls: [{ id: "x" }] } }] }])).toolCalls).toBe(true)
    expect(assembleChatCompletion(sse([{ error: { message: "over quota" } }])).error).toBe("over quota")
  })
})

describe("validateHandoff", () => {
  test("drops the scratch part, keeps the sections, and scrubs environment and identity details", () => {
    const text = [
      "## Scratch",
      "- something — shown above: nowhere",
      "",
      "## Why",
      "- /Users/x/repo/.agent-duel/worktrees/abc/generation-3-a/src/upload.ts: retry there (as Claude Opus 5.5 would)",
      "- preview at http://localhost:4312/upload and turn3-a--chat.localhost",
      "",
      "## Unsure",
      "- curl localhost:4312/health was the only check; see src/openai.ts",
    ].join("\n")
    const result = validateHandoff(text, [deepseek, claude])
    if ("reason" in result) throw new Error(result.reason)
    expect(result.note.startsWith("## Why")).toBe(true)
    expect(result.note).not.toContain("Scratch")
    expect(result.note).toContain("- src/upload.ts: retry there (as [model] would)")
    expect(result.note).toContain("<local url>")
    expect(result.note).toContain("<preview host>")
    expect(result.note).toContain("curl localhost/health was the only check; see src/openai.ts")
    expect(result.note).not.toContain("Claude")
  })

  test("recognises an empty handoff, a reply without sections, and a vendor claim", () => {
    expect(validateHandoff(`## Scratch\n- x — shown above: "y"\n\n${NOTHING_TO_CARRY}`, [deepseek])).toEqual({
      reason: "nothing-to-carry",
    })
    expect(validateHandoff("## Why\n", [deepseek])).toEqual({ reason: "nothing-to-carry" })
    expect(validateHandoff("I changed the uploader.", [deepseek])).toEqual({ reason: "format" })
    expect(validateHandoff(`${draftText}\n- I am an assistant developed by DeepSeek`, [deepseek])).toEqual({
      reason: "identity",
    })
  })

  test("keeps whole sections up to the size cap", () => {
    const long = HANDOFF_HEADINGS.map((heading) => `${heading}\n- ${"x".repeat(1_500)}`).join("\n")
    const result = validateHandoff(long, [deepseek])
    if ("reason" in result) throw new Error(result.reason)
    expect(result.note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS)
    expect(result.note.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(3)
    expect(result.note.endsWith("x")).toBe(true)
  })
})

describe("handleCarryRequest", () => {
  test("replays the winner's final call, drops the scratch part, and returns the note once", async () => {
    const { db, rows } = memoryDb()
    await storeSet(db, "select:a")
    await storeCapture(db)
    const sent: Record<string, unknown>[] = []
    const route = service(db, replyingFetch(sent)).carry
    const first = await route(carryRequest())
    expect(first.status).toBe(200)
    const answer = (await first.json()) as Record<string, unknown>
    expect(answer).toEqual({ version: 1, source: "replay", note: draftText })

    expect(sent).toHaveLength(1)
    const replay = sent[0]!
    const messages = replay.messages as Record<string, unknown>[]
    expect(messages.slice(0, 4)).toEqual(capturedBody.messages)
    expect(messages[4]).toEqual({
      role: "assistant",
      content: "Added a retry with backoff in src/upload.ts.",
      reasoning: "Check the uploader first.",
      reasoning_details: [{ type: "reasoning.text", text: "Check the uploader first.", format: "deepseek-v1" }],
    })
    expect(messages[5]).toEqual({ role: "user", content: HANDOFF_REQUEST })
    // The rest is the contestant call as sent: same model, routing, cache key, reasoning and output cap.
    const { messages: _messages, ...rest } = replay
    const { messages: _captured, ...expected } = capturedBody
    expect(rest).toEqual(expected)

    // A later request reads the record; the model is not asked again.
    const second = await route(carryRequest())
    expect(await second.json()).toEqual(answer)
    expect(sent).toHaveLength(1)
    const stored = rows("arenaCarries")[0]!
    expect(stored.state).toBe("complete")
    expect(stored.source).toBe("replay")
    expect(stored.provider).toBe("Together")
    expect(stored.noteChars).toBe(draftText.length)
  })

  test("answers no note when the winner's cache is cold, and records why", async () => {
    const { db, rows } = memoryDb()
    await storeSet(db, "select:a", claude)
    await storeCapture(db, claude.slug, new Date(Date.now() - 20 * 60_000))
    const sent: Record<string, unknown>[] = []
    const answer = await service(db, replyingFetch(sent)).carry(carryRequest())
    expect(await answer.json()).toEqual({ version: 1, source: "none", reason: "cold" })
    expect(sent).toHaveLength(0)
    expect(rows("arenaCarries")[0]!.reason).toBe("cold")
  })

  test("answers no note when the model has nothing to carry or ignores the format", async () => {
    const { db } = memoryDb()
    await storeSet(db, "select:a")
    await storeCapture(db)
    const sent: Record<string, unknown>[] = []
    const empty = await service(
      db,
      replyingFetch(sent, [`## Scratch\n- a — shown above: "b"\n\n${NOTHING_TO_CARRY}`]),
    ).carry(carryRequest())
    expect(await empty.json()).toEqual({ version: 1, source: "none", reason: "nothing-to-carry" })
    expect(sent).toHaveLength(1)
    const { db: other } = memoryDb()
    await storeSet(other, "select:a")
    await storeCapture(other)
    const answer = await service(other, replyingFetch([], ["Sure! The uploader now retries."])).carry(carryRequest())
    expect(await answer.json()).toEqual({ version: 1, source: "none", reason: "format" })
  })

  test("refuses an open battle, another decision and the wrong side", async () => {
    const { db } = memoryDb()
    await storeSet(db, undefined)
    await storeCapture(db)
    const route = service(db, replyingFetch([])).carry
    expect((await route(carryRequest())).status).toBe(403)
    const { db: decided } = memoryDb()
    await storeSet(decided, "select:b")
    await storeCapture(decided)
    const mismatch = service(decided, replyingFetch([])).carry
    expect((await mismatch(carryRequest({ decision: "select:a" }))).status).toBe(403)
    // select:b names the other assignment, whose capture this is not.
    const other = await mismatch(carryRequest({ decision: "select:b" }))
    expect(await other.json()).toEqual({ version: 1, source: "none", reason: "capture-mismatch" })
  })

  test("answers 404 unless the service carries, as a control plane without the route would", async () => {
    const { db } = memoryDb()
    const disabled = service(db, replyingFetch([]), { carry: false })
    expect((await disabled.carry(carryRequest())).status).toBe(404)
    expect((await disabled.route(carryRequest()))?.status).toBe(404)
  })

  test("warm windows follow the vendor", () => {
    expect(warmWindowMs("anthropic/claude-opus-5.5")).toBe(270_000)
    expect(warmWindowMs("deepseek/deepseek-v4.1-flash-1017")).toBe(Infinity)
    expect(warmWindowMs("unknown/model")).toBe(600_000)
  })
})
