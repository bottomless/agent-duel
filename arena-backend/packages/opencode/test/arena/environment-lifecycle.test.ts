import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { connectLocalStore } from "@/arena/local-store"
import { ArenaRuntime } from "@/arena/runtime"
import { ArenaPreviewPlugin } from "@/arena/preview-plugin"
import type { RunDocument, TurnDocument } from "@/arena/records"

// Cases were selected from the port-change bug brief before inspecting its implementation.
// These exercise real SQLite lookup/reopen and request projection, not voting or model behavior.
const epoch = Date.parse("2026-01-01T00:00:00Z")
const assignment = { assignmentID: "opaque", requestedReasoning: {}, enforcedReasoning: {} }

function turn(chat: string, index: number): TurnDocument {
  const id = `${chat}-${index}`
  return {
    _id: id,
    chatID: chat,
    turnIndex: index,
    userPrompt: "Continue the preview",
    frozenBaseSHA: "base",
    sourceCanonicalSessionID: `${chat}-canonical`,
    canonicalTranscriptHash: "hash",
    pair: ["opaque-a", "opaque-b"],
    placement: { A: assignment, B: assignment },
    runIDs: { A: `${id}-A`, B: `${id}-B` },
    state: "complete",
    transitionTimestamps: {},
    comparisonState: "complete",
    appliedSide: index % 2 ? "B" : "A",
    createdAt: new Date(epoch + index * 1000),
    updatedAt: new Date(epoch + index * 1000),
  }
}

function run(chat: string, index: number, port: number, side: "A" | "B" = "A"): RunDocument {
  const id = `${chat}-${index}-${side}`
  const date = new Date(epoch + index * 1000)
  return {
    _id: id,
    turnID: `${chat}-${index}`,
    side,
    rootSessionID: `ses_${id}`,
    descendantSessionIDs: [`ses_${id}-child`],
    sourceCanonicalSessionID: `${chat}-canonical`,
    forkOperationID: `${id}-fork`,
    moveOperationID: `${id}-move`,
    proxyAssignmentID: id,
    assignment,
    worktree: `/scratch/${id}`,
    portAliases: { PASEO_PORT: port },
    services: [
      {
        kind: "owned_process",
        command: "npm",
        args: ["run", "dev"],
        env: {},
        relativeCwd: ".",
        listeners: [{ port, alias: "PASEO_PORT", verifiedAt: date }],
        proxyRoutes: [
          { hostname: `${id}.localhost`, url: `http://${id}.localhost:8080`, port, alias: "PASEO_PORT", active: true },
        ],
        capturedAt: date,
        verifiedAt: date,
      },
    ],
    worktreeCreatedAt: date,
    durationMs: 1,
    runState: "complete",
    retries: [],
    permissionOutcomes: [],
    questionOutcomes: [],
    toolCount: 1,
    testCommands: [],
    createdAt: date,
    updatedAt: date,
  }
}

function history(session: string, text: string, created = epoch + 100): SessionV1.WithParts[] {
  const sessionID = SessionID.make(`ses_${session}`)
  const messageID = MessageID.make("msg_history")
  const base = { sessionID, messageID }
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_prompt"),
        modelID: "contestant",
        providerID: "arena",
        mode: "",
        agent: "build",
        path: { cwd: "/scratch", root: "/scratch" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created },
      },
      parts: [
        { ...base, id: PartID.make("prt_text"), type: "text", text },
        {
          ...base,
          id: PartID.make("prt_tool"),
          type: "tool",
          tool: "bash",
          callID: "call",
          state: {
            status: "completed",
            input: { command: "curl http://127.0.0.1:31001/health" },
            output: "source fixture 31001 http://localhost:31001",
            title: "check",
            metadata: { checksum: "31001" },
            time: { start: created, end: created + 1 },
          },
        },
        {
          ...base,
          id: PartID.make("prt_image"),
          type: "file",
          mime: "image/png",
          filename: "31001.png",
          url: "data:image/png;base64,iVBORw0KGgo31001AAAA",
        },
        {
          ...base,
          id: PartID.make("prt_reasoning"),
          type: "reasoning",
          text: "31001 http://localhost:31001",
          metadata: { signature: "signed-31001" },
          time: { start: created, end: created + 1 },
        },
      ],
    },
  ]
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "arena-port-lifecycle-"))
  const previous = process.env.OPENCODE_ARENA
  process.env.OPENCODE_ARENA = "1"
  let database = await connectLocalStore({ directory })
  ArenaRuntime.setStoreForTest(database)
  return {
    get database() {
      return database
    },
    async seed(chat: string, entries: Array<{ index: number; port: number; side?: "A" | "B" }>) {
      for (const entry of entries) {
        await database.turns.insertOne(turn(chat, entry.index))
        await database.runs.insertOne(run(chat, entry.index, entry.port, entry.side))
      }
    },
    async reopen() {
      ArenaRuntime.setStoreForTest(undefined)
      await database.close()
      database = await connectLocalStore({ directory })
      ArenaRuntime.setStoreForTest(database)
    },
    async [Symbol.asyncDispose]() {
      ArenaRuntime.registry.assignments.clear()
      ArenaRuntime.setStoreForTest(undefined)
      await database.close()
      if (previous === undefined) delete process.env.OPENCODE_ARENA
      else process.env.OPENCODE_ARENA = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("three turns map both earlier winners to the current bank without modifying source history", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001, side: "B" },
    { index: 2, port: 32001 },
    { index: 3, port: 33001 },
  ])
  const input = history(
    "chat-3-A",
    "Previous previews http://localhost:31001/x and http://localhost:32001/y; count 31001.",
  )
  const snapshot = structuredClone(input)
  const originalTool = input[0].parts[1]
  if (originalTool.type !== "tool") throw new Error("history fixture must contain a tool call")
  const records = await state.database.runsForChat("chat")
  const projected = await ArenaRuntime.projectEnvironment(input)
  expect(projected[0].parts[0]).toEqual({
    ...input[0].parts[0],
    text: "Previous previews http://localhost:33001/x and http://localhost:33001/y; count 31001.",
  })
  expect(projected[0].parts[1]).toEqual({
    ...input[0].parts[1],
    state: {
      ...originalTool.state,
      input: { command: "curl 'http://127.0.0.1:33001/health'" },
    },
  })
  expect(projected[0].parts.slice(2)).toEqual(input[0].parts.slice(2))
  expect(input).toEqual(snapshot)
  expect(await state.database.runsForChat("chat")).toEqual(records)
})

test("retry and store reopen reconstruct child-session context without an in-memory assignment", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001, side: "B" },
    { index: 2, port: 32001 },
  ])
  const input = history("chat-2-A-child", "Use http://chat-1-b.localhost:8080/health?value=31001")
  const initial = await ArenaRuntime.projectEnvironment(input)
  expect(initial[0].parts[0]).toEqual({
    ...input[0].parts[0],
    text: "Use http://chat-2-a.localhost:8080/health?value=31001",
  })
  await state.database.updateRun("chat-2-A", { runState: "error", errorRetryable: true, manualRetries: 1 })
  expect(await ArenaRuntime.projectEnvironment(input)).toEqual(initial)
  await state.reopen()
  expect(ArenaRuntime.registry.assignments.size).toBe(0)
  expect(await ArenaRuntime.projectEnvironment(input)).toEqual(initial)
})

test("other chats, future turns and unassigned sessions cannot contribute historical aliases", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
    { index: 3, port: 33001 },
  ])
  await state.seed("other", [{ index: 1, port: 34001 }])
  const text = "http://localhost:31001 http://localhost:33001 http://localhost:34001 http://other-1-A.localhost:8080"
  const input = history("chat-2-A", text)
  expect((await ArenaRuntime.projectEnvironment(input))[0].parts[0]).toEqual({
    ...input[0].parts[0],
    text: "http://localhost:32001 http://localhost:33001 http://localhost:34001 http://other-1-A.localhost:8080",
  })
  const ordinary = history("ordinary-session", text)
  expect(await ArenaRuntime.projectEnvironment(ordinary)).toEqual(ordinary)
})

test("the same historical copy projects independently for each side, retaining user input and current assistant output", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  await state.database.runs.insertOne(run("chat", 2, 32501, "B"))
  const first = history("chat-2-A", "http://localhost:31001")
  const second = history("chat-2-B", "http://localhost:31001")
  const [a, b] = await Promise.all([ArenaRuntime.projectEnvironment(first), ArenaRuntime.projectEnvironment(second)])
  expect(a[0].parts[0]).toEqual({ ...first[0].parts[0], text: "http://localhost:32001" })
  expect(b[0].parts[0]).toEqual({ ...second[0].parts[0], text: "http://localhost:32501" })
  const current = history("chat-2-A", "http://localhost:31001", epoch + 2000)
  expect(await ArenaRuntime.projectEnvironment(current)).toEqual(current)
  const user: SessionV1.WithParts = {
    info: {
      id: MessageID.make("msg_user"),
      sessionID: SessionID.make("ses_chat-2-A"),
      role: "user",
      time: { created: epoch },
      agent: "build",
      model: { providerID: "arena", modelID: "contestant" },
    },
    parts: first[0].parts,
  }
  expect(await ArenaRuntime.projectEnvironment([user])).toEqual([user])
})

test("compaction summary history is projected while single-agent assignments remain untouched", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  const input = history(
    "chat-2-A",
    "Summary: browser was at http://localhost:31001/preview. External source: https://example.org/31001",
  )
  if (input[0].info.role !== "assistant") throw new Error("history fixture must contain an assistant message")
  input[0].info = { ...input[0].info, summary: true }
  expect((await ArenaRuntime.projectEnvironment(input))[0].parts[0]).toEqual({
    ...input[0].parts[0],
    text: "Summary: browser was at http://localhost:32001/preview. External source: https://example.org/31001",
  })
  ArenaRuntime.registry.assign("ses_chat-2-A", {
    runID: "chat-2-A",
    rootSessionID: "chat-2-A",
    scopeID: "scope",
    assignmentID: "opaque",
    telemetry: false,
  })
  expect(await ArenaRuntime.projectEnvironment(input)).toEqual(input)
})

async function activeTurn(state: Awaited<ReturnType<typeof fixture>>, chat = "chat", index = 2) {
  await state.database.turns.updateOne({ _id: `${chat}-${index}` }, { $set: { state: "running" } })
  await state.database.runs.updateOne({ _id: `${chat}-${index}-A` }, { $set: { runState: "pending" } })
}

test("execution corrects owned server arguments for descendants without mutating caller data", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  await activeTurn(state)
  const args = {
    command: "npm run dev -- --port 31001",
    timeout: 15000,
    description: "invoice 31001 http://localhost:31001",
    image: "data:image/png;base64,31001",
    metadata: { userData: "http://localhost:31001" },
  }
  const snapshot = structuredClone(args)
  const projected = await ArenaRuntime.projectToolEnvironment("ses_chat-2-A-child", "bash", args)
  expect(projected).toEqual({ ...snapshot, command: "npm run dev -- --port '32001'" })
  expect(args).toEqual(snapshot)
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "bash", projected)).toEqual(projected)
})

test("execution leaves current-bank ports intact when an older bank used them for another alias", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  await state.database.runs.updateOne(
    { _id: "chat-1-A" },
    { $set: { portAliases: { PASEO_PORT: 31001, PASEO_PORT2: 32001 } } },
  )
  await state.database.runs.updateOne(
    { _id: "chat-2-A" },
    { $set: { portAliases: { PASEO_PORT: 32001, PASEO_PORT2: 33001 } } },
  )
  await activeTurn(state)
  const args = { command: "npm run dev -- --port 32001; curl http://127.0.0.1:32001/health" }
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "bash", args)).toEqual(args)
  expect(
    await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "browser_navigate", { url: "http://localhost:32001/" }),
  ).toEqual({ url: "http://localhost:32001/" })
})

test("execution isolates other chats, ordinary assignments, resolved turns and opaque tools", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  await state.seed("other", [
    { index: 1, port: 34001 },
    { index: 2, port: 35001 },
  ])
  await activeTurn(state)
  await activeTurn(state, "other")
  const args = { command: "curl http://localhost:31001", content: "http://localhost:31001", filePath: "/tmp/31001.txt" }
  expect(await ArenaRuntime.projectToolEnvironment("ses_other-2-A", "bash", args)).toEqual(args)
  expect(await ArenaRuntime.projectToolEnvironment("ses_unknown", "bash", args)).toEqual(args)
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "write", args)).toEqual(args)
  ArenaRuntime.registry.assign("ses_chat-2-A", {
    runID: "chat-2-A",
    rootSessionID: "ses_chat-2-A",
    scopeID: "scope",
    assignmentID: "ordinary",
    telemetry: false,
  })
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "bash", args)).toEqual(args)
  ArenaRuntime.registry.assignments.clear()
  await state.database.turns.updateOne({ _id: "chat-2" }, { $set: { state: "complete" } })
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "bash", args)).toEqual(args)
})

test("browser execution updates only the target authority and the plugin preserves argument identity", async () => {
  await using state = await fixture()
  await state.seed("chat", [
    { index: 1, port: 31001 },
    { index: 2, port: 32001 },
  ])
  await activeTurn(state)
  const args = {
    url: "http://chat-1-a.localhost:8080/a%2Fb?original=31001#31001",
    body: "http://localhost:31001/body",
    headers: { sentinel: "http://localhost:31001/header" },
  }
  const expected = { ...args, url: "http://chat-2-a.localhost:8080/a%2Fb?original=31001#31001" }
  expect(await ArenaRuntime.projectToolEnvironment("ses_chat-2-A", "paseo_browser_navigate", args)).toEqual(expected)
  const plugin = await ArenaPreviewPlugin({
    directory: "/scratch",
    worktree: "/scratch",
    project: { id: "test-project", worktree: "/scratch", time: { created: epoch } },
    client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }),
    serverUrl: new URL("http://127.0.0.1:1"),
    experimental_workspace: {
      register() {
        throw new Error("workspace registration is outside this hook")
      },
    },
    $: Bun.$,
  })
  const hook = plugin["tool.execute.before"]
  if (!hook) throw new Error("Arena tool execution hook is missing")
  const output = { args: structuredClone(args) }
  const identity = output.args
  await hook({ sessionID: "ses_chat-2-A", tool: "paseo_browser_navigate", callID: "call-browser" }, output)
  expect(output.args).toBe(identity)
  expect(output.args).toEqual(expected)
  expect(args.url).toBe("http://chat-1-a.localhost:8080/a%2Fb?original=31001#31001")
})

test("a projected shell request reaches the real current listener while preserving payload and header bytes", async () => {
  await using state = await fixture()
  let staleRequests = 0
  const stale = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      staleRequests++
      return new Response("wrong listener")
    },
  })
  const current = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return Response.json({
        marker: "current",
        path: new URL(request.url).pathname + new URL(request.url).search,
        body: await request.text(),
        header: request.headers.get("x-sentinel"),
      })
    },
  })
  try {
    const oldPort = stale.port!
    await state.seed("chat", [
      { index: 1, port: oldPort },
      { index: 2, port: current.port! },
    ])
    await activeTurn(state)
    const body = `http://localhost:${oldPort}/opaque`
    const args = {
      command: `curl --max-time 5 -sS --data-binary '${body}' -H 'X-Sentinel: ${body}' 'http://127.0.0.1:${oldPort}/echo%2Fpart?original=${oldPort}'`,
    }
    const snapshot = structuredClone(args)
    const projected = await ArenaRuntime.projectToolEnvironment("ses_chat-2-A-child", "bash", args)
    if (typeof projected.command !== "string") throw new Error("projected command missing")
    const process = Bun.spawn(["sh", "-c", projected.command], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(process.stdout).json()
    expect(await process.exited).toBe(0)
    expect(output).toEqual({ marker: "current", path: `/echo%2Fpart?original=${oldPort}`, body, header: body })
    expect(staleRequests).toBe(0)
    expect(args).toEqual(snapshot)
  } finally {
    await stale.stop(true)
    await current.stop(true)
  }
})
