import { Effect } from "effect"
import { ArenaResponseRecovery } from "../response-recovery"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** A main model request's session and the root session of its run. */
export type MainSession = { readonly sessionID: string; readonly rootSessionID: string }

// Core's provider fetch (`AISDK.providerFetch`) fails a request with these messages when its
// header or SSE chunk deadline passes. Heartbeat comments do not move either deadline.
const TIMEOUT_MESSAGES = new Set(["SSE read timed out", "Response headers timed out"])

// OpenAI-compatible finish reasons of a complete step: 1.x `stop` and `tool-calls`.
const NORMAL_FINISH = new Set(["stop", "tool_calls"])
// A non-null finish reason, in compact or spaced JSON.
const FINISH_VALUE = /"finish_reason"\s*:\s*"/

// Timed-out main model requests since the session's last normally finished one, as 1.x counted them
// (`ArenaResponseRecovery.count`: a user message or a complete response ends the sequence). Kept in
// memory: an engine restart marks the running turn interrupted, and nothing continues it without a
// new prompt, which ends the sequence in 1.x too.
const timeouts = new Map<string, number>()
// Sessions whose main request is a retry after a timeout, until that request's stream ends. After the
// last timeout it keeps the session until the run settles, so the pane never shows the session as
// working between the final timeout and the failure.
const recovering = new Map<string, number>()
// The run each counted session belongs to, so a settled run can drop all of its sessions.
const roots = new Map<string, string>()

function timeoutError(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) return false
  return TIMEOUT_MESSAGES.has(error.message) || timeoutError(error.cause, depth + 1)
}

/** True for a model request that Core stopped at its header or chunk deadline. */
export function idleTimeout(error: { readonly type: string; readonly message: string }) {
  const message = error.message.replace(/^Connection lost while reading the response: /, "")
  return error.type === "provider.transport" && TIMEOUT_MESSAGES.has(message)
}

/** True for the failure that ends a turn whose timeout budget is spent. */
export function idleExhausted(error: { readonly message: string }) {
  return error.message === ArenaResponseRecovery.IDLE_EXHAUSTED
}

/** Ends the session's timeout sequence: a new prompt, or a normally finished response. */
export function resetIdleBudget(sessionID: string) {
  timeouts.delete(sessionID)
  recovering.delete(sessionID)
  roots.delete(sessionID)
}

/** Drops every session of a settled run: the root and its child agents. */
export function resetIdleRun(rootSessionID: string) {
  resetIdleBudget(rootSessionID)
  for (const [sessionID, root] of roots) if (root === rootSessionID) resetIdleBudget(sessionID)
}

/** Runs `effect`, then drops the run's timeout state however the effect ends. */
export function withIdleCleanup<A, E, R>(rootSessionID: string, effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.ensuring(Effect.sync(() => resetIdleRun(rootSessionID))))
}

/** The recovery attempt the session is running after a timeout, or undefined. */
export function idleRecovery(sessionID: string) {
  return recovering.get(sessionID)
}

function timedOut(sessionID: string, error: unknown) {
  if (!timeoutError(error)) return error
  const count = (timeouts.get(sessionID) ?? 0) + 1
  timeouts.set(sessionID, count)
  if (count <= ArenaResponseRecovery.MAX_RECOVERIES) {
    recovering.set(sessionID, count)
    return error
  }
  // As in 1.x: three recoveries in a row, then the run ends with this neutral explanation. The label
  // stays (see `recovering`) until the run settles or a new prompt starts.
  timeouts.delete(sessionID)
  return new Error(ArenaResponseRecovery.IDLE_EXHAUSTED)
}

/**
 * Reads the finish of an OpenAI-compatible SSE stream without holding it: only the unfinished last
 * line is kept. A step is normal when its last finish reason is `stop` or `tool_calls` and no event
 * carries an error.
 */
function finishReader() {
  const decoder = new TextDecoder()
  let pending = ""
  let finish: string | undefined
  let failed = false
  const line = (text: string) => {
    if (!text.startsWith("data:")) return
    // Most deltas carry `"finish_reason":null`; parse only the events that can change the result.
    if (!text.includes('"error"') && !FINISH_VALUE.test(text)) return
    let event: unknown
    try {
      event = JSON.parse(text.slice(5))
    } catch {
      return
    }
    if (typeof event !== "object" || event === null) return
    if ("error" in event && event.error !== null && event.error !== undefined) failed = true
    if (!("choices" in event) || !Array.isArray(event.choices)) return
    for (const choice of event.choices as unknown[]) {
      if (typeof choice !== "object" || choice === null || !("finish_reason" in choice)) continue
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason
    }
  }
  return {
    push(chunk: Uint8Array) {
      const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n")
      pending = lines.pop() ?? ""
      for (const text of lines) line(text.trim())
    },
    normal() {
      line((pending + decoder.decode()).trim())
      pending = ""
      return !failed && finish !== undefined && NORMAL_FINISH.has(finish)
    },
  }
}

/**
 * Bounds the wait for response headers and counts the timeouts of main model requests (the ones
 * `mainSession` returns a session for) against the recovery budget. Title and compaction requests
 * get the deadline but neither count nor end a recovery. The request that would exceed the budget
 * fails with `IDLE_EXHAUSTED`, which the retry hook does not retry.
 *
 * The header deadline lives here, not in Core's provider fetch: Core aborts with "Response headers
 * timed out", but its HTTP hook middleware turns that abort into an interruption ("All fibers
 * interrupted without error"), which hides the timeout.
 */
export function idleBudgetFetch(
  send: Fetch,
  options: { readonly mainSession: (headers: Headers) => MainSession | undefined; readonly headerTimeoutMs: number },
): Fetch {
  return async (input, init) => {
    const main = options.mainSession(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    )
    if (main) roots.set(main.sessionID, main.rootSessionID)
    const sessionID = main?.sessionID
    const fail = (error: unknown) => (sessionID ? timedOut(sessionID, error) : error)
    const headers = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Response headers timed out")
        headers.abort(error)
        reject(error)
      }, options.headerTimeoutMs)
    })
    const signal = init?.signal ? AbortSignal.any([init.signal, headers.signal]) : headers.signal
    const response = await Promise.race([send(input, { ...init, signal }), deadline])
      .catch((error: unknown) => {
        throw fail(error)
      })
      .finally(() => clearTimeout(timer))
    // An error answer (offline, 5xx) neither counts nor ends the sequence.
    if (!sessionID || !response.ok) return response
    if (!response.body) {
      recovering.delete(sessionID)
      return response
    }
    const finish = finishReader()
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const part = await reader.read().catch((error: unknown) => {
          throw timedOut(sessionID, error)
        })
        if (part.done) {
          // The recovery request is over. Only a complete step ends the sequence, as in 1.x; a
          // `length` cutoff or an in-stream error does not.
          if (finish.normal()) resetIdleBudget(sessionID)
          else recovering.delete(sessionID)
          controller.close()
          return
        }
        finish.push(part.value)
        controller.enqueue(part.value)
      },
      cancel: (reason) => reader.cancel(reason),
    })
    return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText })
  }
}

export * as ArenaEngineIdle from "./idle.js"
