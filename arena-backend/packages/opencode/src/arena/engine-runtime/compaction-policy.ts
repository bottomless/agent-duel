import { Effect, Stream } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { COMPACTION_POLICY_PATH, COMPACTION_TURNS_HEADER } from "@agent-duel/arena-service/compaction-policy-contract"
import { PROVIDER_ID } from "./models"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Multiple steers before the same final answer are one turn, not separate completed turns. */
export function turnsAfterReply(history: readonly { type: string; status?: string; finish?: string }[]) {
  let completed = 0
  let pending = false
  for (const message of history) {
    if (message.type === "compaction" && message.status === "completed") {
      // History folds retained exchanges into the checkpoint's text. It proves at least one turn.
      completed = Math.max(1, completed)
      pending = false
    }
    if (message.type === "user") pending = true
    if (message.type === "assistant" && message.finish === "stop" && pending) {
      completed++
      pending = false
    }
  }
  return completed + Number(pending)
}

/** Observe the blinded reply without changing the bytes the native SDK consumes. */
export function captureReply(response: Response) {
  let finished = false
  let failed = false
  let stopped = false
  const reply: {
    role: string
    content: string
    reasoning?: string
    reasoning_content?: string
    reasoning_details: unknown[]
  } = { role: "assistant", content: "", reasoning_details: [] }
  const observe = (value: unknown) => {
    if (!record(value)) return
    if (value.error !== undefined) failed = true
    if (!Array.isArray(value.choices)) return
    for (const choice of value.choices) {
      if (!record(choice) || (choice.index !== undefined && choice.index !== 0)) continue
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) stopped = choice.finish_reason === "stop"
      const part = choice.delta ?? choice.message
      if (!record(part)) continue
      if (Array.isArray(part.tool_calls) && part.tool_calls.length) failed = true
      for (const key of ["content", "reasoning", "reasoning_content"] as const) {
        if (typeof part[key] === "string") reply[key] = (reply[key] ?? "") + part[key]
      }
      if (Array.isArray(part.reasoning_details)) reply.reasoning_details.push(...part.reasoning_details)
    }
  }
  const result = () => (finished && stopped && !failed ? reply : undefined)
  if (!response.body || !response.ok) return { response, result }
  // OpenRouter's native Arena adapter uses chat SSE. Unsupported transports skip the policy.
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return { response, result }
  const decoder = new TextDecoder()
  let pending = ""
  const line = (text: string) => {
    if (!text.startsWith("data:")) return
    const data = text.slice(5).trim()
    if (!data) return
    if (data === "[DONE]") {
      finished = true
      return
    }
    try {
      observe(JSON.parse(data))
    } catch {
      failed = true
    }
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const text of lines) line(text)
        controller.enqueue(chunk)
      },
      flush() {
        pending += decoder.decode()
        if (pending) line(pending)
        finished = true
      },
    }),
  )
  return { response: new Response(body, { status: response.status, headers: response.headers }), result }
}

/** Run the gate only at a settled root turn, then enqueue ordinary native compaction. */
export function installCompactionPolicy(
  context: Context,
  contestantFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return Effect.gen(function* () {
    const candidates = new Map<
      string,
      {
        request: Request
        input: { model: unknown; messages: unknown[]; completedUserTurns: number }
        result: ReturnType<typeof captureReply>["result"]
      }
    >()
    yield* Effect.addFinalizer(() => Effect.sync(() => candidates.clear()))
    yield* context.event.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted" ||
            event.type === "session.execution.succeeded"
          ) {
            candidates.delete(String(event.data.sessionID))
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* context.session.hook(
      "http.response",
      (event) =>
        Effect.promise(async () => {
          if (event.kind !== "primary") return
          candidates.delete(String(event.sessionID))
          const turns = Number(event.request.headers.get(COMPACTION_TURNS_HEADER))
          if (!Number.isSafeInteger(turns) || turns < 2 || !event.response.ok) return
          const input: unknown = await event.request.clone().json()
          if (!record(input) || !Array.isArray(input.messages)) return
          const captured = captureReply(event.response)
          event.response = captured.response
          candidates.set(String(event.sessionID), {
            request: event.request,
            input: { model: input.model, messages: input.messages, completedUserTurns: turns },
            result: captured.result,
          })
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook("experimental.idle", (event) =>
      Effect.gen(function* () {
        const candidate = candidates.get(String(event.sessionID))
        candidates.delete(String(event.sessionID))
        if (!candidate || event.background.length) return
        const reply = candidate.result()
        if (!reply) return
        const compact = yield* Effect.tryPromise(async () => {
          const url = new URL(candidate.request.url)
          url.pathname = COMPACTION_POLICY_PATH
          const headers = new Headers(candidate.request.headers)
          headers.delete("content-length")
          const response = await contestantFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: candidate.input.model,
              completedUserTurns: candidate.input.completedUserTurns,
              messages: [...candidate.input.messages, reply],
            }),
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) {
            await response.body?.cancel()
            return false
          }
          const decision: unknown = await response.json()
          return record(decision) && decision.compact === true
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        if (compact)
          yield* context.session
            .compact({ sessionID: event.sessionID })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Arena could not enqueue between-turn compaction", { sessionID: event.sessionID }),
              ),
            )
      }),
    )
  })
}

export * as ArenaCompactionPolicy from "./compaction-policy"
