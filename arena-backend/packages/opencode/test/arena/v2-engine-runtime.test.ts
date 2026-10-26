import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { AISDK } from "@opencode/core/aisdk"
import { LLM, LLMClient } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { FetchHttpClient } from "effect/http"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import { AssignmentRegistry } from "@/arena/proxy"
import { clearToolExecutionEnvironment, gateToolExecution } from "@/session/tool-execution-gate"
import { SessionID } from "@/session/schema"
import {
  CONTESTANT_IDENTITY,
  PROVIDER_ID,
  createArenaEnginePlugin,
  contestantModel,
  modelReference,
  permissionRules,
  previewEnvironment,
  promptCacheKey,
  requestHeaders,
  resolveAssignment,
  requestNeedsCompaction,
  requestTokenEstimate,
  clearArenaAutoAccept,
  getArenaAutoAccept,
  sandboxForSession,
  setArenaAutoAccept,
} from "@/arena/engine-runtime"
import { contestant } from "@/arena/model-profile"
import type { Model } from "@opencode/schema/model"

describe("Arena v2 engine runtime", () => {
  it("publishes only opaque contestant models with bounded reasoning variants", () => {
    expect(String(PROVIDER_ID)).toBe("arena")
    expect(contestantModel.name).toBe("Contestant")
    expect(contestantModel.limit).toEqual({ context: contestant.contextWindow, output: contestant.outputLimit })
    expect(contestantModel.variants).toEqual([{ id: "high", body: { reasoning: { effort: "high" } } }])
    expect(modelReference(undefined)).toBe("arena/contestant#high")
    const imageRequest = {
      messages: [{ role: "user", content: [{ type: "image", data: "a".repeat(2_000_000) }] }],
    }
    expect(requestTokenEstimate(imageRequest)).toBeLessThan(10_000)
    expect(requestNeedsCompaction({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] })).toBe(true)
  })

  it("adds blinded request identity and stable cache lineage headers", () => {
    const headers = requestHeaders({ sessionID: "ses_abc", kind: "compaction", parentSessionID: "ses_parent" })
    expect(headers["x-session-affinity"]).toBe("ses_abc")
    expect(headers["x-parent-session-id"]).toBe("ses_parent")
    expect(headers["x-arena-session-id"]).toBe("ses_abc")
    expect(headers["x-arena-root-session-id"]).toBe("ses_abc")
    expect(headers["x-arena-parent-session-id"]).toBe("ses_parent")
    expect(headers["x-arena-generation-classification"]).toBe("compaction")
    expect(headers["x-arena-request-id"]).toMatch(/^[0-9a-f-]{36}$/)
    expect(promptCacheKey("ses_" + "a".repeat(64))).toBe("a".repeat(64))
    expect(CONTESTANT_IDENTITY).toContain("identity is hidden")
  })

  it("keeps automatic permission approval scoped to a session", () => {
    clearArenaAutoAccept("ses_auto_accept")
    expect(getArenaAutoAccept("ses_auto_accept")).toBe(false)
    setArenaAutoAccept("ses_auto_accept", true)
    expect(getArenaAutoAccept("ses_auto_accept")).toBe(true)
    clearArenaAutoAccept("ses_auto_accept")
    expect(getArenaAutoAccept("ses_auto_accept")).toBe(false)
  })

  it("propagates an assignment to descendants and scopes their temp environment", () => {
    const assignment = {
      runID: "run",
      rootSessionID: "root",
      scopeID: "scope",
      assignmentID: "assignment",
      telemetry: false,
    } as const
    const assignments = {
      assignments: new Map([["root", assignment]]),
      assign(sessionID: string, value: typeof assignment) {
        this.assignments.set(sessionID, value)
        return value
      },
      resolve(sessionID: string, parentSessionID?: string) {
        const value = this.assignments.get(parentSessionID ?? "")
        if (!value) throw new Error("missing parent")
        return this.assign(sessionID, value)
      },
    }
    expect(resolveAssignment(assignments, "child", "root")).toEqual(assignment)
    const sandbox = sandboxForSession("child", "/repo/.agent-duel/worktree", "/repo")
    expect(sandbox.tmp).toContain("child")
    expect(permissionRules(undefined, sandbox).slice(-3)).toEqual([
      { action: "external_directory", resource: `${sandbox.tmp}/*`, effect: "allow" },
      { action: "read", resource: `${sandbox.tmp}/*`, effect: "allow" },
      { action: "edit", resource: `${sandbox.tmp}/*`, effect: "allow" },
    ])
    expect(previewEnvironment("child").TMPDIR).toBe(sandbox.tmp)
  })

  it("routes the current Core AI SDK path through the Arena fetch and keeps the request opaque", async () => {
    const assignment = {
      runID: "run",
      rootSessionID: "ses_probe",
      scopeID: "scope",
      assignmentID: "assignment",
      telemetry: false,
    } as const
    const assignments = {
      assignments: new Map([["ses_probe", assignment]]),
      assign(sessionID: string, value: typeof assignment) {
        this.assignments.set(sessionID, value)
        return value
      },
      resolve(sessionID: string, parentSessionID?: string) {
        const value = this.assignments.get(parentSessionID ?? "")
        if (!value) throw new Error("missing parent")
        return this.assign(sessionID, value)
      },
    }
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    // Bun 1.4 does not assign an ephemeral port for `port: 0`. Pick from a
    // process-local range and retry if another targeted test owns the first
    // candidate. The request still crosses a real loopback HTTP boundary.
    const server = (() => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          return Bun.serve({
            hostname: "127.0.0.1",
            port: 43_000 + ((process.pid + attempt) % 1_000),
            async fetch(request) {
              requests.push({
                headers: new Headers(request.headers),
                body: (await request.clone().json()) as Record<string, unknown>,
              })
              return new Response(
                'data: {"id":"resp","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n',
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          })
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("in use")) throw error
        }
      }
      throw new Error("Could not allocate a loopback test port")
    })()

    const registrations = { dispose: Effect.void }
    const sessionCallbacks = new Map<string, Array<(event: any) => Effect.Effect<void>>>()
    const permissionCallbacks = new Map<string, (event: any) => Effect.Effect<void>>()
    let subagentExecute: ((input: unknown, call: { sessionID: string }) => Effect.Effect<unknown>) | undefined
    const noOp = () => Effect.succeed(registrations)
    const aisdkLayer = AISDK.locationLayer
    const clientLayer = LLMClient.layer.pipe(
      Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))),
    )
    const run = Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const context: any = {
        provider: { transform: noOp },
        aisdk: {
          hook: (name: string, callback: any, options?: { providerID?: string }) =>
            name === "sdk"
              ? aisdk.hook.sdk((event) =>
                  options?.providerID !== undefined && options.providerID !== event.model.providerID
                    ? Effect.void
                    : callback(event),
                )
              : aisdk.hook.language((event) =>
                  options?.providerID !== undefined && options.providerID !== event.model.providerID
                    ? Effect.void
                    : callback(event),
                ),
        },
        session: {
          hook: (name: string, callback: (event: any) => Effect.Effect<void>) => {
            const callbacks = sessionCallbacks.get(name) ?? []
            callbacks.push(callback)
            sessionCallbacks.set(name, callbacks)
            return Effect.succeed(registrations)
          },
          get: (input: { sessionID: string }) =>
            Effect.succeed({
              id: input.sessionID,
              parentID: input.sessionID === "child" ? "ses_probe" : "ses_root",
            }),
        },
        permission: {
          hook: (name: string, callback: (event: any) => Effect.Effect<void>) => {
            permissionCallbacks.set(name, callback)
            return Effect.succeed(registrations)
          },
        },
        shell: { hook: noOp },
        tool: {
          hook: noOp,
          transform: (callback: (editor: any) => void) =>
            Effect.sync(() => {
              const subagent = {
                execute(input: unknown, call: { sessionID: string }) {
                  return Effect.succeed(input)
                },
              }
              callback({
                get: (id: string) => (id === "subagent" ? subagent : undefined),
                update: (_id: string, update: (tool: typeof subagent) => void) => {
                  update(subagent)
                  subagentExecute = subagent.execute
                },
              })
            }),
        },
      }
      yield* createArenaEnginePlugin({
        enabled: true,
        assignments,
        autoAccept: true,
        contestantFetch: async (input, init) => {
          const incoming = new Request(input, init)
          return fetch(server.url, {
            method: incoming.method,
            headers: incoming.headers,
            body: incoming.body,
          })
        },
      }).effect(context)

      const system: Array<{ type: "text"; text: string }> = [
        { type: "text", text: "You are powered by the model named leaked. The exact model ID is leaked/provider" },
        { type: "text", text: "# Your Model\n- Name: Contestant\n- Provider ID: arena\n- Model ID: contestant" },
        { type: "text", text: "Keep the user instructions." },
      ]
      const runSessionHooks = (name: string, event: any) =>
        Effect.forEach(sessionCallbacks.get(name) ?? [], (callback) => callback(event), { discard: true })
      expect(sessionCallbacks.get("context")?.length).toBe(2)
      const contextEvent = {
        sessionID: "ses_probe",
        model: { providerID: PROVIDER_ID } as Model.Ref,
        system,
        options: {},
      }
      yield* runSessionHooks("context", contextEvent)
      expect(contextEvent.system).toEqual([
        { type: "text", text: CONTESTANT_IDENTITY },
        { type: "text", text: "Keep the user instructions." },
      ])

      const retry = sessionCallbacks.get("retry")?.at(0)
      expect(retry).toBeDefined()
      const networkFailure = {
        sessionID: "ses_probe",
        model: { providerID: PROVIDER_ID },
        error: {
          type: "provider.internal",
          status: 503,
          response: {
            body: JSON.stringify({ error: { type: "arena_network_unavailable" } }),
          },
        },
        decision: { retry: false },
      }
      yield* retry!(networkFailure)
      expect(networkFailure.decision).toEqual({
        retry: true,
        delay: 2_000,
        persistent: true,
        message: "Waiting for network",
      })

      // A child is assigned before its first model request, even if Core has not
      // emitted the prompt hook yet.
      const childSystem: Array<{ type: "text"; text: string }> = []
      yield* runSessionHooks("context", {
        sessionID: "child",
        model: { providerID: PROVIDER_ID } as Model.Ref,
        system: childSystem,
        options: {},
      })
      expect(assignments.assignments.has("child")).toBe(true)

      const permission = permissionCallbacks.get("evaluate")!
      const denied = { sessionID: "ses_probe", effect: "deny", action: "edit" }
      yield* permission(denied)
      expect(denied.effect).toBe("deny")
      const allowed = { sessionID: "ses_probe", effect: "ask", action: "edit" }
      yield* permission(allowed)
      expect(allowed.effect).toBe("allow")
      const question = { sessionID: "ses_probe", effect: "ask", action: "question" }
      yield* permission(question)
      expect(question.effect).toBe("ask")

      const forced = yield* subagentExecute!({ model: "openai/real-model" }, { sessionID: "ses_probe" })
      expect((forced as { model: string }).model).toBe("arena/contestant#high")

      const model = yield* aisdk.model({
        ...contestantModel,
        body: { reasoning: { effort: "high" } },
        settings: {},
      })
      const request = LLM.stream({
        model,
        system: contextEvent.system,
        prompt: "hello",
        http: {
          headers: requestHeaders({ sessionID: "ses_probe", parentSessionID: "ses_root", kind: "primary" }),
        },
      })
      yield* request.pipe(Stream.runDrain, Effect.provide(clientLayer))
    }).pipe(Effect.provide(aisdkLayer), Effect.scoped)

    try {
      await Effect.runPromise(run)
    } finally {
      server.stop(true)
    }
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    const body = request.body
    expect(body.model).toBe("contestant")
    expect(body.provider).toBeUndefined()
    expect(JSON.stringify(body)).toContain(CONTESTANT_IDENTITY)
    expect(JSON.stringify(body)).not.toContain("leaked/provider")
    expect(request.headers.get("x-session-id")).toBe("ses_probe")
    expect(request.headers.get("x-session-affinity")).toBe("ses_probe")
    expect(request.headers.get("x-parent-session-id")).toBe("ses_root")
    expect(request.headers.get("x-arena-generation-classification")).toBe("generation")
    expect(request.headers.get("x-arena-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    expect(request.headers.get("authorization")).toBe("Bearer arena-local-proxy")
  })

  it("executes a real Core Session prompt through the in-memory Arena fetch", async () => {
    const assignment = {
      runID: "run-core",
      rootSessionID: "",
      scopeID: "scope-core",
      assignmentID: "assignment-core",
      telemetry: false,
    } as const
    const assignments = new AssignmentRegistry()
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    let delegateMode = false
    let toolCalls = 0
    let denyMode = false
    let deniedToolCalls = 0
    let idleMode = false
    let idleRequests = 0
    let providerRuns = 0
    let executionEnvironment: ReturnType<typeof gateToolExecution> | undefined
    let server: ReturnType<typeof Bun.serve> | undefined
    for (let attempt = 0; attempt < 20 && !server; attempt++) {
      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 44_000 + ((process.pid + attempt) % 1_000),
          idleTimeout: 1,
          async fetch(request) {
            requests.push({
              headers: new Headers(request.headers),
              body: (await request.clone().json()) as Record<string, unknown>,
            })
            if (idleMode && idleRequests++ === 0) {
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"id":"resp-idle","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-partial","type":"function","function":{"name":"edit","arguments":"{\\"path\\":\\"partial"}}]},"finish_reason":null}]}\n\n',
                    ),
                  )
                },
              })
              return new Response(body, { headers: { "content-type": "text/event-stream" } })
            }
            if (denyMode && deniedToolCalls++ === 0) {
              const path = `${import.meta.dir}/.agent-duel/arena-v2-${infoForTest}.txt`
              return new Response(
                `data: {"id":"resp-deny","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-edit","type":"function","function":{"name":"edit","arguments":"{\\"path\\":\\"${path}\\",\\"oldString\\":\\"missing\\",\\"newString\\":\\"blocked\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"resp-deny","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n`,
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            if (delegateMode && toolCalls++ === 0) {
              return new Response(
                'data: {"id":"resp-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-subagent","type":"function","function":{"name":"subagent","arguments":"{\\"description\\":\\"child\\",\\"prompt\\":\\"reply\\",\\"agent\\":\\"general\\",\\"model\\":\\"openai/arbitrary\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"resp-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n',
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            return new Response(
              'data: {"id":"resp-core","choices":[{"index":0,"delta":{"content":"Arena core reply"},"finish_reason":null}]}\n\ndata: {"id":"resp-core","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n',
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("in use")) throw error
      }
    }
    if (!server) throw new Error("Could not allocate a loopback test port")

    const contestantFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      headers.delete("authorization")
      return fetch(`http://127.0.0.1:${server!.port}/v1/chat/completions`, {
        method: request.method,
        headers,
        body: request.body,
        // Bun's Request body is a stream and the OpenRouter SDK may pass it through directly.
        // The loopback server is the only network boundary this test permits.
        duplex: "half",
      } as RequestInit)
    }
    const scope = Scope.makeUnsafe()
    let infoForTest = "pending"
    try {
      const extension = Layer.effectDiscard(
        Effect.gen(function* () {
          const sdk = yield* SdkPlugins.Service
          yield* sdk.register(
            createArenaEnginePlugin({
              enabled: true,
              assignments,
              contestantFetch,
              modelIdleTimeoutMs: 5,
              retryDelayMs: 0,
            }),
          )
        }),
      )
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
            [],
            extension,
          ).pipe(Layer.provide(HttpServer.layerServices)),
          scope,
        ),
      )
      const sessions = Context.get(context, CoreSession.Service)
      const info = await Effect.runPromise(
        sessions.create({
          location: { directory: import.meta.dir },
          model: { providerID: "arena", id: "contestant", variant: "high" },
        }),
      )
      infoForTest = info.id
      setArenaAutoAccept(info.id, true)
      assignments.assign(info.id, { ...assignment, rootSessionID: info.id })
      executionEnvironment = gateToolExecution(SessionID.make(info.id), {
        worktree: import.meta.dir,
        copiedPaths: [],
        provide: (effect) =>
          Effect.gen(function* () {
            providerRuns++
            return yield* effect
          }),
      })
      executionEnvironment.release()
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "reply once", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("10 seconds")))

      expect(requests.length).toBeGreaterThanOrEqual(1)
      const messages = await Effect.runPromise(sessions.messages({ sessionID: info.id, order: "asc" }))
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Arena core reply")),
        ),
      ).toBe(true)
      const request = requests.find((entry) => entry.headers.get("x-arena-generation-classification") === "generation")
      expect(request).toBeDefined()
      if (!request) throw new Error("Core did not send a generation request")
      expect(request.body.model).toBe("contestant")
      expect(JSON.stringify(request.body)).not.toContain("deepseek")
      expect(JSON.stringify(request.body)).toContain(CONTESTANT_IDENTITY)
      expect(JSON.stringify(request.body)).not.toContain("openai/arbitrary")
      expect(
        (request.body.tools as Array<{ function?: { name?: string } }>).some(
          (tool) => tool.function?.name === "subagent",
        ),
      ).toBe(true)
      expect(request.headers.get("x-arena-generation-classification")).toBe("generation")
      expect(request.headers.get("x-arena-session-id")).toBe(info.id)
      expect(request.headers.get("x-arena-root-session-id")).toBe(info.id)
      expect(request.headers.get("x-session-id")).toBe(info.id)
      expect(request.headers.get("authorization")).toBeNull()

      delegateMode = true
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "delegate once", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("30 seconds")))
      expect(assignments.assignments.size).toBeGreaterThan(1)
      const delegated = requests.filter(
        (entry) => entry.headers.get("x-arena-generation-classification") === "generation",
      )
      expect(delegated.length).toBeGreaterThan(1)
      expect(delegated.every((entry) => entry.body.model === "contestant")).toBe(true)
      const childRequest = delegated.find((entry) => entry.headers.get("x-arena-parent-session-id") === info.id)
      expect(childRequest).toBeDefined()
      expect(childRequest?.headers.get("x-arena-root-session-id")).toBe(info.id)
      expect(providerRuns).toBeGreaterThan(0)

      const deniedPath = `${import.meta.dir}/.agent-duel/arena-v2-${info.id}.txt`
      await Effect.runPromise(
        sessions.setPermissions({
          sessionID: info.id,
          permissions: permissionRules(undefined, sandboxForSession(info.id, import.meta.dir, import.meta.dir)),
        }),
      )
      denyMode = true
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "write once", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("10 seconds")))
      // The first request is the blocked edit call; Core then asks the model
      // for a recovery response after the durable permission failure.
      expect(deniedToolCalls).toBe(2)
      expect(existsSync(deniedPath)).toBe(false)

      idleMode = true
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "recover interrupted tool", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("15 seconds")))
      // The first response stops after a partial tool argument. Core cancels
      // the pending call and continues the turn after the bounded idle retry.
      expect(idleRequests).toBeGreaterThanOrEqual(2)
      const recovered = await Effect.runPromise(sessions.messages({ sessionID: info.id, order: "asc" }))
      expect(
        recovered.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Arena core reply")),
        ),
      ).toBe(true)
    } finally {
      if (infoForTest !== "pending") clearArenaAutoAccept(infoForTest)
      if (infoForTest !== "pending") clearToolExecutionEnvironment(SessionID.make(infoForTest))
      server.stop(true)
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }, 30_000)
})
