import { afterEach, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { RequestExecutor } from "@opencode/ai/route"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { createRoutes } from "@opencode/server/routes"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { contestantModel } from "@/arena/engine-runtime/models"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import type { Session } from "@opencode/schema/session"
import type { PromptInput } from "@opencode/schema/prompt-input"
import { AssignmentRegistry } from "@/arena/proxy"
import { createArenaEnginePlugin } from "@/arena/engine-runtime/plugin"
import { canCompactHistory, compactionResponse } from "@/arena/engine-runtime/request"
import { compactionRequiredError, requestTooLargeMessage } from "@agent-duel/arena-service/request-error"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
import { abandonedAttempts, messagesToGraft } from "@/arena/session-runtime/projection"
import { ArenaPorts } from "@/arena/ports"
import { connectLocalStore } from "@/arena/local-store"
import { setStoreForTest } from "@/arena/runtime"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
const summary = `## Objective\n- Continue.\n## Requirements\n- Keep the attachment.\n## Decisions\n- (none)\n## Work State\n### Completed\n- Earlier exchange.\n### Active\n- Current request.\n### Blocked\n- (none)\n## Next Move\n1. Reply.\n## Relevant Files\n- (none)\n## Important Context\n- (none)`
function reply(text: string) {
  return new Response(
    `data: ${JSON.stringify({
      id: "response",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}
const refusal = () => Response.json(compactionRequiredError(), { status: 413 })
afterEach(() => setStoreForTest(undefined))

async function runner(
  fetch: (request: Request) => Promise<Response>,
  body: (sessions: CoreSession.Interface, id: Session.ID) => Promise<void>,
) {
  const assignments = new AssignmentRegistry()
  const scope = Scope.makeUnsafe()
  const directory = await mkdtemp(path.join(tmpdir(), "arena-native-port-"))
  try {
    const extension = Layer.effectDiscard(
      Effect.gen(function* () {
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(
          createArenaEnginePlugin({
            enabled: true,
            assignments,
            contestantFetch: (input, init) => fetch(new Request(input, init)),
            retryDelayMs: 0,
          }),
        )
      }),
    )
    // In-process Core and SQLite: no HTTP listener, daemon, or model service.
    // Native in-memory transport fixture: installation of a provider package is outside this
    // runner test. The request hooks, overflow classifier, checkpoint and retry are Core's.
    const model = LanguageModel.make({
      id: "contestant",
      provider: "arena",
      route: OpenAIChat.route.with({ endpoint: { baseURL: "http://test.invalid/v1" } }),
    })
    const models = makeLocationNode({
      service: SessionRunnerModel.Service,
      deps: [],
      layer: Layer.succeed(SessionRunnerModel.Service, {
        resolve: () =>
          Effect.succeed(
            SessionRunnerModel.resolved(model, {
              capabilities: contestantModel.capabilities,
              cost: [],
              limit: contestantModel.limit,
            }),
          ),
      }),
    })
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return HttpClient.transformResponse(
          client,
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => fetch(new Request(input, init)),
              { preconnect: globalThis.fetch.preconnect },
            ),
          ),
        )
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer))
    const transport = RequestExecutor.layer.pipe(Layer.provide(http))
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        createRoutes(
          {
            app: { version: "test" },
            database: { path: ":memory:" },
            fs: { filewatcher: false },
            models: { fetch: false },
          },
          () => [],
          [SessionRunnerModel.node.replace(models), requestExecutor.replace(transport)],
          extension,
        ).pipe(Layer.provide(HttpServer.layerServices)),
        scope,
      ),
    )
    const sessions = Context.get(context, CoreSession.Service)
    const info = await Effect.runPromise(
      sessions.create({ location: { directory }, model: { providerID: "arena", id: "contestant", variant: "high" } }),
    )
    assignments.assign(info.id, {
      runID: "run",
      rootSessionID: info.id,
      scopeID: "scope",
      assignmentID: "assignment",
      telemetry: false,
    })
    await body(sessions, info.id)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}
async function prompt(
  sessions: CoreSession.Interface,
  id: Session.ID,
  text: string,
  files?: PromptInput.FileAttachment[],
) {
  await Effect.runPromise(sessions.prompt({ sessionID: id, text, files, resume: true }))
  await Effect.runPromise(sessions.wait(id).pipe(Effect.timeout("10 seconds")))
}

test("control-plane 413 commits a Core checkpoint and retries with the latest attachment intact", async () => {
  const calls: { kind: string | null; offer: string | null; body: unknown }[] = []
  let refused = false
  let summaryRefused = false
  let generations = 0
  await runner(
    async (request) => {
      const kind = request.headers.get("x-arena-generation-classification")
      const offer = request.headers.get("x-arena-compaction")
      calls.push({ kind, offer, body: await request.json() })
      if (kind === "utility") return reply("Title")
      if (kind === "compaction") {
        // Hard-edge summary refusal must use Core's shrinking-summary recovery.
        if (!summaryRefused) {
          summaryRefused = true
          return refusal()
        }
        return reply(summary)
      }
      generations++
      if (offer === "auto" && generations === 5) {
        refused = true
        return refusal()
      }
      return reply(refused ? "Finished" : "Old result ".repeat(5000))
    },
    async (sessions, id) => {
      await prompt(sessions, id, "Earlier exchange")
      await prompt(sessions, id, "More history")
      await prompt(sessions, id, "Third exchange")
      await prompt(sessions, id, "Fourth exchange")
      await prompt(sessions, id, "Inspect the latest attachment", [
        { uri: `data:image/png;base64,${image}`, mime: "image/png", filename: "latest.png" },
      ])
      const messages = await Effect.runPromise(sessions.messages({ sessionID: id, order: "asc" }))
      expect(messages.filter((message) => message.type === "compaction")).toMatchObject([
        { status: "completed", summary },
      ])
      expect(messages.filter((message) => message.type === "assistant").at(-1)).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Finished" }],
      })
      expect(messages.some((message) => message.type === "assistant" && message.error)).toBe(false)
    },
  )
  const primary = calls.filter((call) => call.kind === "generation")
  expect(primary.map((call) => call.offer)).toEqual([null, "auto", "auto", "auto", "auto", null])
  expect(calls.filter((call) => call.kind === "compaction").map((call) => call.offer)).toEqual([null, null])
  for (const call of primary.slice(4)) {
    expect(JSON.stringify(call.body)).toContain("Inspect the latest attachment")
    expect(JSON.stringify(call.body)).toContain(`data:image/png;base64,${image}`)
  }
})

test("first-request and post-summary hard refusals fail neutrally without another compaction", async () => {
  for (const afterSummary of [false, true]) {
    let generations = 0
    let summaries = 0
    await runner(
      async (request) => {
        const kind = request.headers.get("x-arena-generation-classification")
        if (kind === "utility") return reply("Title")
        if (kind === "compaction") {
          summaries++
          return reply(summary)
        }
        generations++
        if (afterSummary && generations === 1) return reply("Earlier reply")
        return refusal()
      },
      async (sessions, id) => {
        if (afterSummary) await prompt(sessions, id, "Earlier exchange")
        await prompt(sessions, id, "Cannot fit")
        const messages = await Effect.runPromise(sessions.messages({ sessionID: id, order: "asc" }))
        expect(messages.filter((message) => message.type === "assistant").at(-1)).toMatchObject({
          error: { message: requestTooLargeMessage },
        })
      },
    )
    expect(summaries).toBe(afterSummary ? 1 : 0)
    expect(generations).toBe(afterSummary ? 3 : 1)
  }
})

test("does not compact at 272K without a control-plane refusal", async () => {
  let summaries = 0
  let primary = 0
  await runner(
    async (request) => {
      const kind = request.headers.get("x-arena-generation-classification")
      if (kind === "utility") return reply("Title")
      if (kind === "compaction") {
        summaries++
        return reply(summary)
      }
      primary++
      return reply(primary === 1 ? "x".repeat(272_000 * 4 + 1000) : "Finished")
    },
    async (sessions, id) => {
      await prompt(sessions, id, "Earlier exchange")
      await prompt(sessions, id, "Continue")
      const messages = await Effect.runPromise(sessions.messages({ sessionID: id, order: "asc" }))
      expect(messages.filter((message) => message.type === "compaction")).toEqual([])
    },
  )
  expect(summaries).toBe(0)
  expect(primary).toBe(2)
})

test.each(["empty", "reasoning", "partial"] as const)(
  "an idle %s reply uses the right recovery note and keeps its row",
  async (mode) => {
    const expected = mode === "partial" ? ArenaResponseRecovery.IDLE_CONTINUE : ArenaResponseRecovery.IDLE_RESTART
    let primary = 0
    const requests: unknown[] = []
    let idleController: ReadableStreamDefaultController<Uint8Array> | undefined
    await runner(
      async (request) => {
        if (request.headers.get("x-arena-generation-classification") !== "generation") return reply("Title")
        requests.push(await request.json())
        if (++primary > 1) return reply("Recovered")
        if (mode === "empty") throw new Error("Response headers timed out")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              idleController = controller
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: "reasoning-only", choices: [{ index: 0, delta: { reasoning: "Thinking without writing", ...(mode === "partial" ? { content: "A partial answer" } : {}) }, finish_reason: null }] })}\n\n`,
                ),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      async (sessions, id) => {
        await Effect.runPromise(sessions.prompt({ sessionID: id, text: "Recover this idle response", resume: true }))
        if (mode !== "empty")
          await Effect.runPromise(
            Effect.gen(function* () {
              while (true) {
                const rows = yield* sessions.messages({ sessionID: id, order: "asc" })
                if (
                  rows.some(
                    (message) =>
                      message.type === "assistant" && message.content.some((part) => part.type === "reasoning"),
                  )
                )
                  return
                yield* Effect.yieldNow
              }
            }).pipe(Effect.timeout("2 seconds")),
          )
        if (mode !== "empty") idleController!.error(new Error("SSE read timed out"))
        await Effect.runPromise(sessions.wait(id).pipe(Effect.timeout("10 seconds")))
        const messages = await Effect.runPromise(sessions.messages({ sessionID: id, order: "asc" }))
        expect(messages.filter((message) => message.type === "assistant")).toHaveLength(2)
        expect(messages.filter((message) => message.type === "synthetic")).toMatchObject([{ text: expected }])
        expect(messages.filter((message) => message.type === "assistant").at(-1)).toMatchObject({
          finish: "stop",
          content: [{ type: "text", text: "Recovered" }],
        })
        const first = messages.find((message) => message.type === "assistant")!
        const note = messages.find((message) => message.type === "synthetic")!
        const boundary = messages.find((message) => message.type === "user")!.id
        expect(messagesToGraft(messages, boundary)).toContain(first)
        expect(messagesToGraft(messages, boundary)).toContain(note)
        expect([...abandonedAttempts(messages, boundary)]).toEqual([first.id, note.id])
      },
    )
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain(expected)
    expect(JSON.stringify(requests[1])).not.toContain("Continue from where you left off")
  },
)

test("only the exact neutral 413 is converted and history eligibility stops at a checkpoint", async () => {
  const request = new Request("http://test.invalid", { headers: { "x-arena-compaction": "auto" } })
  for (const response of [
    Response.json({ error: { type: "private_error" } }, { status: 413 }),
    Response.json(compactionRequiredError(), { status: 400 }),
  ])
    expect(await compactionResponse(response, request, "primary")).toBe(response)
  expect(canCompactHistory([{ type: "user" }])).toBe(false)
  expect(
    canCompactHistory([
      { type: "assistant", finish: "stop" },
      { type: "compaction", status: "completed" },
      { type: "user" },
    ]),
  ).toBe(false)
  expect(
    canCompactHistory([
      { type: "compaction", status: "completed" },
      { type: "assistant", finish: "stop" },
      { type: "user" },
    ]),
  ).toBe(true)
})

test("native shell refuses retired ports and hosts for contestants and descendants before execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-port-wrapper-"))
  const store = await connectLocalStore({ directory })
  setStoreForTest(store)
  const assignments = new AssignmentRegistry()
  for (const id of ["root", "child"])
    assignments.assign(id, {
      runID: "current",
      rootSessionID: "root",
      scopeID: "scope",
      assignmentID: "assignment",
      telemetry: true,
    })
  await store.turns.insertOne({ _id: "old", chatID: "chat", turnIndex: 1 } as any)
  await store.turns.insertOne({ _id: "current-turn", chatID: "chat", turnIndex: 2 } as any)
  await store.runs.insertOne({
    _id: "old-run",
    turnID: "old",
    chatID: "chat",
    portAliases: { PASEO_PORT: 20000 },
    services: [{ listeners: [{ port: 20000 }] }],
  } as any)
  await store.runs.insertOne({
    _id: "current",
    turnID: "current-turn",
    chatID: "chat",
    rootSessionID: "root",
    descendantSessionIDs: ["child"],
    worktree: directory,
    portAliases: { PASEO_PORT: 20113 },
  } as any)
  let executions = 0
  const shell: any = {
    id: "shell",
    name: "shell",
    execute: () =>
      Effect.sync(() => {
        executions++
        return "executed"
      }),
  }
  const noOp = () => Effect.succeed({ dispose: Effect.void })
  const context: any = {
    location: { directory, project: { directory } },
    provider: { transform: noOp },
    agent: { transform: noOp },
    aisdk: { hook: noOp },
    session: { hook: noOp, get: () => Effect.succeed({ id: "root", location: { directory }, permissions: [] }) },
    shell: { hook: noOp },
    permission: { hook: noOp },
    event: { subscribe: () => Stream.empty },
    tool: {
      hook: noOp,
      transform: (callback: any) =>
        Effect.sync(() =>
          callback({
            namespace() {},
            list: () => [],
            get: (id: string) => (id === "shell" ? shell : undefined),
            update: (_id: string, update: any) => update(shell),
          }),
        ),
    },
  }
  try {
    await Effect.runPromise(createArenaEnginePlugin({ enabled: true, assignments }).effect(context).pipe(Effect.scoped))
    const environment = await ArenaPorts.environment(store, "root")
    expect(environment?.retiredPorts).toEqual(new Set([20000]))
    const host = [...environment!.retiredHosts][0]
    for (const sessionID of ["root", "child"])
      for (const command of ["python3 -m http.server 20000", `curl http://${host}`]) {
        const result = await Effect.runPromiseExit(shell.execute({ command }, { sessionID }))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(String(result.cause)).toContain(ArenaPorts.violation(environment!, command)!)
      }
    expect(executions).toBe(0)
    expect(await Effect.runPromise(shell.execute({ command: "echo 20113" }, { sessionID: "root" }))).toBe("executed")
    expect(await Effect.runPromise(shell.execute({ command: "echo 20000" }, { sessionID: "ordinary" }))).toBe(
      "executed",
    )
    setStoreForTest({
      runs: {
        findOne: async () => {
          throw new Error("lookup failed")
        },
      },
    } as any)
    expect(await Effect.runPromise(shell.execute({ command: "echo 20000" }, { sessionID: "root" }))).toBe("executed")
  } finally {
    setStoreForTest(undefined)
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
