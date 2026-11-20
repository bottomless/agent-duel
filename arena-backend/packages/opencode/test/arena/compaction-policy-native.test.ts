import { expect } from "bun:test"
import { z } from "zod"
import { Context, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import { createArenaEnginePlugin } from "@/arena/engine-runtime/plugin"
import { AssignmentRegistry, proxy } from "@/arena/proxy"
import { createReasoningRedactor } from "@agent-duel/arena-service/reasoning"
import { compactionPolicy } from "@agent-duel/arena-service/compaction-policy"
import { COMPACTION_POLICY_PATH } from "@agent-duel/arena-service/compaction-policy-contract"
import { testEffect } from "../../../core/test/lib/effect"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"

const it = testEffect(Layer.empty)

it.live("compacts an eligible second turn through native Core and keeps its latest exchange", () =>
  Effect.gen(function* () {
    const { path: directory } = yield* tmpdirScoped()
    const assignments = new AssignmentRegistry()
    const assignment = {
      runID: "run",
      rootSessionID: "",
      scopeID: "policy",
      assignmentID: "assignment",
      telemetry: false,
    }
    const redactor = createReasoningRedactor("test-key", {
      userId: "test",
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
    })
    const sent: { messages: unknown[]; summary: boolean }[] = []
    let measurements = 0
    let useReasoning = true
    let measurementAvailable = true
    const contestantFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const summary = request.headers.get("x-arena-generation-classification") === "compaction"
      return proxy(request, assignments, {
        upstream: "https://control.test/api/openrouter",
        fetch: async (input, init) => {
          const routed = new Request(input, init)
          const body = z
            .object({ messages: z.array(z.unknown()), completedUserTurns: z.number().optional() })
            .passthrough()
            .parse(await routed.json())
          if (new URL(routed.url).pathname.endsWith(COMPACTION_POLICY_PATH)) {
            measurements++
            if (!measurementAvailable) return Response.json({ error: "unavailable" }, { status: 503 })
            return Response.json(compactionPolicy(body, redactor.restore(body, true)))
          }
          sent.push({ messages: body.messages, summary })
          const content = summary
            ? "## Objective\nRetain the original requirements."
            : "LATEST_ANSWER must remain verbatim."
          const value = redactor.redact(
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    content,
                    ...(!summary && useReasoning ? { reasoning: "Think carefully. ".repeat(5000) } : {}),
                  },
                  finish_reason: "stop",
                },
              ],
            },
            true,
          )
          return new Response(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
    }
    const extension = Layer.effectDiscard(
      Effect.gen(function* () {
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(createArenaEnginePlugin({ enabled: true, assignments, contestantFetch, retryDelayMs: 0 }))
      }),
    )
    const native = yield* Layer.build(
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
    )
    const sessions = Context.get(native, CoreSession.Service)
    const info = yield* sessions.create({
      location: { directory },
      model: { providerID: "arena", id: "contestant", variant: "high" },
    })
    assignments.assign(info.id, { ...assignment, rootSessionID: info.id })
    const prompt = (text: string) =>
      sessions
        .prompt({ sessionID: info.id, text, resume: true })
        .pipe(Effect.andThen(sessions.wait(info.id)), Effect.timeout("10 seconds"))
    yield* prompt("ORIGINAL_REQUIREMENT: preserve input validation.")
    expect(measurements).toBe(0)
    expect(sent.filter((request) => request.summary)).toHaveLength(0)
    yield* prompt("LATEST_TURN: give me the final answer.")
    expect(measurements).toBe(1)
    expect(sent.filter((request) => request.summary)).toHaveLength(1)
    const rows = yield* sessions.messages({ sessionID: info.id, order: "asc" })
    const checkpoint = rows.find((message) => message.type === "compaction" && message.status === "completed")
    const latest = rows.find((message) => message.type === "user" && message.text.includes("LATEST_TURN"))
    expect(checkpoint?.metadata?.keepID).toBe(latest?.id)
    expect(checkpoint).toBeDefined()
    const history = yield* sessions.context(info.id)
    expect(JSON.stringify(history)).toContain("LATEST_TURN")
    expect(JSON.stringify(history)).toContain("LATEST_ANSWER")
    // Native compaction may read the full cache prefix, but retains this exchange verbatim.
    expect(JSON.stringify(sent.find((request) => request.summary)?.messages).includes("## Objective")).toBe(true)

    // The next turn sees the native checkpoint; a low-reasoning turn does not compact again.
    useReasoning = false
    yield* prompt("Continue without further changes.")
    expect(measurements).toBe(2)
    expect(sent.filter((request) => request.summary)).toHaveLength(1)
    expect(JSON.stringify(sent.at(-1)?.messages)).toContain("LATEST_TURN")
    measurementAvailable = false
    useReasoning = true
    yield* prompt("Finish this turn even if the measurement service is unavailable.")
    expect(measurements).toBe(3)
    expect(sent.filter((request) => request.summary)).toHaveLength(1)
  }),
)
