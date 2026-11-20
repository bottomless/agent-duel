import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { AISDK } from "@opencode/core/aisdk"
import { ai, LLMClient, Media, Message } from "@opencode/ai/effect"
import { RequestExecutor } from "@opencode/ai/route"
import { FetchHttpClient } from "effect/http"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import { ReadTool } from "@opencode/core/tool/plugin/read"
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
  requestIdentity,
  RETRY_MARK_SLACK_MS,
  resolveAssignment,
  requestTokenEstimate,
  clearArenaAutoAccept,
  getArenaAutoAccept,
  idleRecovery,
  resetIdleBudget,
  resetIdleRun,
  ArenaEngineIdle,
  sandboxForSession,
  setArenaAutoAccept,
} from "@/arena/engine-runtime"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
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
    expect(requestTokenEstimate({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] })).toBeGreaterThan(
      272_000,
    )
  })

  it("charges OpenCode 2 image shapes a fixed allowance instead of their base64 size", () => {
    // About a 1.4 MB PNG; at four characters per token its base64 alone is about 470k tokens.
    const png = Buffer.alloc(1_400_000, 7)
    const base64 = png.toString("base64")
    const request = {
      system: [{ type: "text", text: "You are a contestant." }],
      messages: [
        Message.user([
          Message.text("Look at screenshot.png and describe it."),
          Message.media(Media.base64(base64, "image/png"), { filename: "pasted.png" }),
          Message.media(Media.bytes(new Uint8Array(png), "image/png"), { filename: "bytes.png" }),
        ]),
        Message.assistant([{ type: "tool-call", id: "call_1", name: "read", input: { filePath: "screenshot.png" } }]),
        Message.tool({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: ReadTool.toModelContent("screenshot.png", undefined, {
              type: "file",
              encoding: "base64",
              mime: "image/png",
              content: base64,
            }),
          },
        }),
      ],
    }
    // Two user media parts and one read result image, each charged once.
    const estimate = requestTokenEstimate(request)
    expect(estimate).toBeGreaterThanOrEqual(12_000)
    expect(estimate).toBeLessThan(13_000)
    expect(requestTokenEstimate(request)).toBeLessThan(272_000)
    // The JSON form of the same request, as hooks and logs serialize it.
    const encoded = JSON.parse(JSON.stringify(request))
    expect(JSON.stringify(encoded).length).toBeGreaterThan(5_000_000)
    expect(requestTokenEstimate(encoded)).toBe(estimate)
    // A stray inline data URI elsewhere still counts as one image.
    expect(requestTokenEstimate({ text: `data:image/png;base64,${base64}` })).toBeLessThan(4_100)
    // Text of the same size still needs compaction.
    expect(requestTokenEstimate({ messages: [Message.user(base64)] })).toBeGreaterThan(272_000)
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

  it("keeps one request ID across the retries of a request", () => {
    const ids = requestIdentity()
    const first = ids.next("ses_a", "primary")
    expect(ids.next("ses_a", "primary")).not.toBe(first)
    const failed = ids.next("ses_a", "primary")
    ids.retryScheduled("ses_a", 2_000)
    // A title request may run while the step waits; it neither takes nor clears the retry.
    expect(ids.next("ses_a", "title")).not.toBe(failed)
    expect(ids.next("ses_b", "primary")).not.toBe(failed)
    expect(ids.next("ses_a", "primary")).toBe(failed)
    ids.retryScheduled("ses_a", 2_000)
    expect(ids.next("ses_a", "primary")).toBe(failed)
    // Retried once, then sent again without a retry: a new logical request.
    expect(ids.next("ses_a", "primary")).not.toBe(failed)

    // The step compacted before its retried request, so the primary request starts fresh.
    const beforeCompaction = ids.next("ses_a", "primary")
    ids.retryScheduled("ses_a", 2_000)
    ids.next("ses_a", "compaction")
    expect(ids.next("ses_a", "primary")).not.toBe(beforeCompaction)
    // Nothing to retry in a session that has sent nothing.
    ids.retryScheduled("ses_new", 2_000)
    expect(ids.next("ses_new", "primary")).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("does not merge a request into a retry that was decided but never sent", () => {
    const ids = requestIdentity()
    // Compaction resends its own request on a retry, without `model.request`. Its retry decision
    // must not make the next compaction, or the primary request after it, look like a resend.
    const primary = ids.next("ses_a", "primary")
    const compaction = ids.next("ses_a", "compaction")
    ids.retryScheduled("ses_a", 2_000)
    expect(ids.next("ses_a", "compaction")).not.toBe(compaction)
    ids.retryScheduled("ses_a", 2_000)
    expect(ids.next("ses_a", "primary")).not.toBe(primary)

    // A step decides on a retry, then fails on an interrupted tool, or a Send now cancels the wait.
    // The manual Retry and the cancel (`cancelRun` in service.ts) clear the decision first.
    const interrupted = ids.next("ses_b", "primary")
    ids.retryScheduled("ses_b", 2_000)
    ids.reset("ses_b")
    expect(ids.next("ses_b", "primary")).not.toBe(interrupted)
  })

  it("keeps a retry linked through a steer, and lets an unsent retry lapse", () => {
    let clock = 0
    const ids = requestIdentity(() => clock)
    // A steer queued during the wait fires no reset for a root session: the retry still goes out.
    const failed = ids.next("ses_a", "primary")
    ids.retryScheduled("ses_a", 40_000)
    clock += 40_500
    expect(ids.next("ses_a", "primary")).toBe(failed)

    // A step decided on a retry and then failed; nothing cleared the mark. Long after its wait the
    // next request in the session is a new one.
    const abandoned = ids.next("ses_a", "primary")
    ids.retryScheduled("ses_a", 2_000)
    clock += 2_000 + RETRY_MARK_SLACK_MS + 1
    expect(ids.next("ses_a", "primary")).not.toBe(abandoned)
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
      reasoningFromMessageID: "msg_20",
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
        agent: { transform: noOp },
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
        event: { subscribe: () => Stream.empty },
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
                list: () => [],
                namespace: () => {},
                remove: () => {},
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
      expect(sessionCallbacks.get("context")?.length).toBe(3)
      const contextEvent = {
        sessionID: "ses_probe",
        model: { providerID: PROVIDER_ID } as Model.Ref,
        system,
        messages: [
          Message.make({
            id: "msg_10",
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "[Thinking redacted]",
                providerMetadata: {
                  openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "arena_reasoning_v1.old" }] },
                },
              },
              { type: "text", text: "Earlier answer" },
            ],
          }),
          Message.make({
            id: "msg_30",
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "",
                providerMetadata: {
                  openrouter: {
                    reasoning_details: [{ type: "reasoning.encrypted", data: "arena_reasoning_v1.current" }],
                  },
                },
              },
              { type: "tool-call", id: "call_current", name: "read", input: {} },
            ],
          }),
          Message.make({ id: "msg_31", role: "assistant", content: [{ type: "reasoning", text: "" }] }),
        ],
        options: {},
      }
      yield* runSessionHooks("context", contextEvent)
      expect(contextEvent.system).toEqual([
        { type: "text", text: CONTESTANT_IDENTITY },
        { type: "text", text: "Keep the user instructions." },
      ])

      expect(contextEvent.messages).toHaveLength(2)
      expect(contextEvent.messages[0].content).toEqual([{ type: "text", text: "Earlier answer" }])
      expect(JSON.stringify(contextEvent.messages[1])).toContain("arena_reasoning_v1.current")
      const retriedContext = { ...contextEvent, messages: [...contextEvent.messages] }
      yield* runSessionHooks("context", retriedContext)
      expect(retriedContext.messages).toEqual(contextEvent.messages)

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
      // A refused session waits for a new sign-in the same way; a model's own 401 does not.
      const sessionRejected = {
        sessionID: "ses_probe",
        model: { providerID: PROVIDER_ID },
        error: {
          type: "provider.auth",
          status: 401,
          response: { body: JSON.stringify({ error: { type: "arena_session_rejected" } }) },
        },
        decision: { retry: false },
      }
      yield* retry!(sessionRejected)
      expect(sessionRejected.decision).toEqual({
        retry: true,
        delay: 2_000,
        persistent: true,
        message: "Waiting for sign-in",
      })
      const modelUnauthorized = {
        sessionID: "ses_probe",
        model: { providerID: PROVIDER_ID },
        error: {
          type: "provider.auth",
          status: 401,
          response: { body: JSON.stringify({ error: { type: "arena_upstream_error" } }) },
        },
        decision: { retry: false },
      }
      yield* retry!(modelUnauthorized)
      expect(modelUnauthorized.decision).toEqual({ retry: false })

      // A child is assigned before its first model request, even if Core has not
      // emitted the prompt hook yet.
      const childSystem: Array<{ type: "text"; text: string }> = []
      yield* runSessionHooks("context", {
        sessionID: "child",
        model: { providerID: PROVIDER_ID } as Model.Ref,
        system: childSystem,
        messages: [],
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
      const request = ai.stream({
        model,
        system: contextEvent.system,
        prompt: "hello",
        headers: requestHeaders({ sessionID: "ses_probe", parentSessionID: "ses_root", kind: "primary" }),
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

  it("bounds header and heartbeat-only stalls per turn but keeps a slow reasoning stream alive", async () => {
    const encoder = new TextEncoder()
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: "resp", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    let mode: "heartbeat" | "reasoning" | "no-headers" = "heartbeat"
    const timers = new Set<ReturnType<typeof setInterval>>()
    // Heartbeats every 5 ms in both modes: only parsed model events may move the 60 ms deadline.
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 5)
          timers.add(heartbeat)
          controller.enqueue(chunk({ role: "assistant", content: "" }))
          if (mode === "heartbeat") return
          // Reasoning-only chunks 30 ms apart for 300 ms, five times the deadline, then the answer.
          let sent = 0
          const reasoning = setInterval(() => {
            if (++sent <= 10) {
              controller.enqueue(chunk({ reasoning_details: [{ type: "reasoning.encrypted", data: `e${sent}` }] }))
              return
            }
            clearInterval(reasoning)
            clearInterval(heartbeat)
            controller.enqueue(chunk({ content: "slow answer" }))
            controller.enqueue(chunk({}, "stop"))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          }, 30)
          timers.add(reasoning)
        },
        cancel() {
          for (const timer of timers) clearInterval(timer)
        },
      })
    // Like the hosted transport, an aborted request rejects with an interruption, not the abort reason.
    const contestantFetch = (_input: string | URL | Request, init?: RequestInit) =>
      mode === "no-headers"
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("All fibers interrupted without error")), {
              once: true,
            }),
          )
        : Promise.resolve(new Response(stream(), { headers: { "content-type": "text/event-stream" } }))
    const sessionID = "ses_idle"
    const assignments = new AssignmentRegistry()
    assignments.assign(sessionID, {
      runID: "run-idle",
      rootSessionID: sessionID,
      scopeID: "scope-idle",
      assignmentID: "assignment-idle",
      telemetry: false,
    })
    const callbacks = new Map<string, Array<(event: any) => Effect.Effect<void>>>()
    const registrations = { dispose: Effect.void }
    const noOp = () => Effect.succeed(registrations)
    const clientLayer = LLMClient.layer.pipe(
      Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))),
    )
    const runHooks = (name: string, event: unknown) =>
      Effect.forEach(callbacks.get(name) ?? [], (callback) => callback(event), { discard: true })
    const run = Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const context: any = {
        provider: { transform: noOp },
        agent: { transform: noOp },
        aisdk: {
          hook: (name: string, callback: any) => (name === "sdk" ? aisdk.hook.sdk(callback) : noOp()),
        },
        session: {
          hook: (name: string, callback: (event: any) => Effect.Effect<void>) => {
            callbacks.set(name, [...(callbacks.get(name) ?? []), callback])
            return Effect.succeed(registrations)
          },
          get: (input: { sessionID: string }) => Effect.succeed({ id: input.sessionID }),
        },
        permission: { hook: noOp },
        shell: { hook: noOp },
        event: { subscribe: () => Stream.empty },
        tool: { hook: noOp, transform: () => Effect.void },
      }
      yield* createArenaEnginePlugin({ enabled: true, assignments, modelIdleTimeoutMs: 60, contestantFetch }).effect(
        context,
      )
      const model = yield* aisdk.model({ ...contestantModel, settings: {} })
      const send = (next: typeof mode, kind: "primary" | "title" = "primary") =>
        Effect.suspend(() => {
          mode = next
          return ai
            .stream({
              model,
              prompt: "hello",
              headers: requestHeaders({ sessionID, kind }),
            })
            .pipe(Stream.runCollect, Effect.provide(clientLayer), Effect.result)
        })
      const failure = Effect.fn(function* (next: typeof mode, kind: "primary" | "title" = "primary") {
        const result = yield* send(next, kind)
        if (result._tag !== "Failure") throw new Error(`A ${next} stall did not time out`)
        return result.failure
      })
      const retryDecision = Effect.fn(function* (error: { type: string; message: string }) {
        const event = { sessionID, error, decision: { retry: true, delay: 2_000 } as Record<string, unknown> }
        yield* runHooks("retry", event)
        return event.decision
      })

      // 1st timeout: heartbeats alone do not move the deadline.
      const stalled = yield* failure("heartbeat")
      expect(stalled.reason).toMatchObject({ _tag: "Transport", operation: "read", message: "SSE read timed out" })
      expect(idleRecovery(sessionID)).toBe(1)
      // The pane names the idle retry with the neutral recovery label, never the transport text.
      expect(yield* retryDecision({ type: "provider.transport", message: "SSE read timed out" })).toEqual({
        retry: true,
        delay: 2_000,
        message: "Continuing after model timeout",
      })

      // A title request neither counts nor ends the contestant's recovery, whether it times out or finishes.
      expect((yield* failure("heartbeat", "title")).message).toContain("SSE read timed out")
      expect(idleRecovery(sessionID)).toBe(1)
      expect((yield* send("reasoning", "title"))._tag).toBe("Success")
      expect(idleRecovery(sessionID)).toBe(1)

      // A slow model that keeps sending reasoning-only events is not cut off. Its finished response
      // ends the recovery and the timeout sequence, as in 1.x.
      const slow = yield* send("reasoning")
      if (slow._tag !== "Success") throw new Error(`A slow reasoning stream failed: ${slow.failure.message}`)
      expect(
        slow.success.some((event) => event.type === "text-delta" && "text" in event && event.text === "slow answer"),
      ).toBe(true)
      expect(idleRecovery(sessionID)).toBeUndefined()

      // 1st timeout of a new sequence: no headers at all is bounded by the same deadline, as in 1.x.
      const headless = yield* failure("no-headers")
      expect(headless.reason).toMatchObject({
        _tag: "Transport",
        operation: "request",
        message: "Response headers timed out",
      })
      expect(yield* retryDecision({ type: "provider.transport", message: "Response headers timed out" })).toMatchObject(
        { retry: true, message: "Continuing after model timeout" },
      )

      // The 2nd and 3rd are recovered; the 4th in a row ends the run with the 1.x explanation.
      expect((yield* failure("heartbeat")).message).toContain("SSE read timed out")
      expect((yield* failure("heartbeat")).message).toContain("SSE read timed out")
      expect(idleRecovery(sessionID)).toBe(3)
      const exhausted = yield* failure("heartbeat")
      expect(exhausted.message).toBe(ArenaResponseRecovery.IDLE_EXHAUSTED)
      expect(yield* retryDecision({ type: "provider.unknown", message: exhausted.message })).toEqual({ retry: false })
      // The label stays until the run settles, so the pane never reads "Working" before "Failed".
      expect(idleRecovery(sessionID)).toBe(3)

      // A new prompt ends a running sequence too.
      expect((yield* failure("heartbeat")).message).toContain("SSE read timed out")
      expect(idleRecovery(sessionID)).toBe(1)
      yield* runHooks("prompt", { sessionID })
      expect(idleRecovery(sessionID)).toBeUndefined()
    }).pipe(Effect.provide(AISDK.locationLayer), Effect.scoped)

    try {
      await Effect.runPromise(run)
    } finally {
      for (const timer of timers) clearInterval(timer)
      resetIdleBudget(sessionID)
    }
  })

  it("ends a timeout sequence only on a normal finish, and drops a settled run's sessions", async () => {
    const root = "ses_idle_root"
    const child = "ses_idle_child"
    const other = "ses_idle_other"
    const sse = (...events: unknown[]) =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    const finish = (reason: string) => ({ id: "r", choices: [{ index: 0, delta: {}, finish_reason: reason }] })
    let answer: () => Promise<Response> = () => Promise.reject(new Error("SSE read timed out"))
    const fetch = ArenaEngineIdle.idleBudgetFetch(() => answer(), {
      headerTimeoutMs: 1_000,
      mainSession: (headers) => {
        const sessionID = headers.get("x-session")
        return sessionID ? { sessionID, rootSessionID: headers.get("x-root") ?? sessionID } : undefined
      },
    })
    const request = async (sessionID: string, rootSessionID = sessionID) => {
      const response = await fetch("https://arena.test", {
        headers: { "x-session": sessionID, "x-root": rootSessionID },
      })
      await response.text()
    }
    const timeout = (sessionID: string, rootSessionID = sessionID) => {
      answer = () => Promise.reject(new Error("SSE read timed out"))
      return request(sessionID, rootSessionID).then(
        () => "finished",
        (error: Error) => error.message,
      )
    }
    const respond = (response: () => Response, sessionID = root) => {
      answer = () => Promise.resolve(response())
      return request(sessionID)
    }

    try {
      expect(await timeout(root)).toBe("SSE read timed out")
      // A `length` cutoff or an error inside a 200 stream ends the recovery request but not the sequence.
      await respond(() =>
        sse({ id: "r", choices: [{ index: 0, delta: { content: "cut" }, finish_reason: null }] }, finish("length")),
      )
      expect(idleRecovery(root)).toBeUndefined()
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(idleRecovery(root)).toBe(2)
      await respond(() => sse({ error: { message: "upstream failed", code: 502 } }))
      await respond(() => sse(finish("error")))
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(idleRecovery(root)).toBe(3)
      // So the next timeout in the sequence is the fourth, which ends the run.
      expect(await timeout(root)).toBe(ArenaResponseRecovery.IDLE_EXHAUSTED)
      resetIdleBudget(root)

      // A `stop` or `tool_calls` finish ends the sequence, as a complete step did in 1.x.
      expect(await timeout(root)).toBe("SSE read timed out")
      await respond(() => sse(finish("tool_calls")))
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(idleRecovery(root)).toBe(1)
      await respond(() => sse(finish("stop")))
      expect(idleRecovery(root)).toBeUndefined()

      // Upstream bytes with a space after the colon are a normal finish too.
      for (let count = 0; count < 3; count++) expect(await timeout(root)).toBe("SSE read timed out")
      expect(idleRecovery(root)).toBe(3)
      await respond(
        () =>
          new Response(
            'data: {"id": "r", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}\n\ndata: [DONE]\n\n',
          ),
      )
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(idleRecovery(root)).toBe(1)
      resetIdleBudget(root)

      // A settle step that fails before finalizing (such as a failing `store.turn`) still drops the run.
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(await timeout(child, root)).toBe("SSE read timed out")
      const settled = await Effect.runPromiseExit(
        ArenaEngineIdle.withIdleCleanup(root, Effect.fail(new Error("store.turn failed"))),
      )
      expect(Exit.isFailure(settled)).toBe(true)
      expect(idleRecovery(root)).toBeUndefined()
      expect(idleRecovery(child)).toBeUndefined()

      // A settled run drops the root and its child agents, and nothing of another run.
      expect(await timeout(root)).toBe("SSE read timed out")
      expect(await timeout(child, root)).toBe("SSE read timed out")
      expect(await timeout(other)).toBe("SSE read timed out")
      resetIdleRun(root)
      expect(idleRecovery(root)).toBeUndefined()
      expect(idleRecovery(child)).toBeUndefined()
      expect(idleRecovery(other)).toBe(1)
      // The child's count is gone too: three more timeouts are recovered again.
      for (const attempt of [1, 2, 3]) {
        expect(await timeout(child, root)).toBe("SSE read timed out")
        expect(idleRecovery(child)).toBe(attempt)
      }
    } finally {
      for (const sessionID of [root, child, other]) resetIdleBudget(sessionID)
    }
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
    let refusals = 0
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
            if (refusals > 0) {
              refusals--
              return Response.json({ error: { message: "upstream failed", code: 500 } }, { status: 500 })
            }
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
      // This fixture counts model calls. Measurement is a separate, unpaid control route.
      if (new URL(request.url).pathname.endsWith("/compaction-policy")) return Response.json({ compact: false })
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
              // Also the header deadline: loopback answers well within it.
              modelIdleTimeoutMs: 5_000,
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
      // Every Arena request asks for the 1.x output cap.
      expect(request.body.max_tokens).toBe(32_000)

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
      expect(childRequest?.body.max_tokens).toBe(32_000)
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
      // Core sends the title request in the background and without an output limit; Arena adds the cap.
      const titles = requests.filter((entry) => entry.headers.get("x-arena-generation-classification") === "utility")
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.map((entry) => entry.body.max_tokens)).toEqual(titles.map(() => 32_000))

      // Core rebuilds the request for each retry; every attempt of one step carries one request ID,
      // which is what telemetry counts retries by. The next step gets a new one.
      idleMode = false
      const sent = requests.length
      refusals = 2
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "retry twice", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("15 seconds")))
      const attempts = requests
        .slice(sent)
        .filter((entry) => entry.headers.get("x-arena-generation-classification") === "generation")
        .map((entry) => entry.headers.get("x-arena-request-id"))
      expect(attempts).toHaveLength(3)
      expect(new Set(attempts).size).toBe(1)
      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "no retry", resume: true }))
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("10 seconds")))
      const next = requests.at(-1)?.headers.get("x-arena-request-id")
      expect(next).toMatch(/^[0-9a-f-]{36}$/)
      expect(next).not.toBe(attempts[0])
    } finally {
      if (infoForTest !== "pending") clearArenaAutoAccept(infoForTest)
      if (infoForTest !== "pending") clearToolExecutionEnvironment(SessionID.make(infoForTest))
      server.stop(true)
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }, 30_000)
})
