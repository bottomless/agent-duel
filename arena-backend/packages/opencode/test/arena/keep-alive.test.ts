import { describe, expect, test } from "bun:test"
import { KEEP_ALIVE_HEADER } from "@agent-duel/arena-service/keep-alive"
import {
  idleSession,
  KeepAlive,
  MAX_WAIT_MS,
  PING_EVERY_MS,
  RETRY_AFTER_MS,
  type PingResult,
} from "../../src/arena/keep-alive"
import { AssignmentRegistry, proxy, streamProgress } from "../../src/arena/proxy"

const MINUTE = 60_000

/** A clock whose timers run only when the test moves it. */
function manualClock() {
  let now = 0
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  return {
    now: () => now,
    schedule(run: () => void, ms: number) {
      const timer = { at: now + ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    async advance(ms: number) {
      const end = now + ms
      while (true) {
        const next = timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        next.cancelled = true
        next.run()
        // Let the ping's promise and the re-arm after it settle.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      now = end
    },
  }
}

function setup(result: PingResult = "kept") {
  const clock = manualClock()
  const keepAlive = new KeepAlive({ now: clock.now, schedule: (run, ms) => clock.schedule(run, ms) })
  const pings: number[] = []
  const ping = async () => {
    pings.push(clock.now())
    return result
  }
  return { clock, keepAlive, pings, ping }
}

describe("ArenaKeepAlive", () => {
  test("pings every four minutes from when the last call started, while the session waits", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    const end = keepAlive.begin("session")
    await clock.advance(1 * MINUTE)
    end(ping)
    await clock.advance(13 * MINUTE)
    expect(pings).toEqual([4 * MINUTE, 8 * MINUTE, 12 * MINUTE])
  })

  test("pings at once when the answer itself took longer than four minutes", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    const end = keepAlive.begin("session")
    await clock.advance(4.5 * MINUTE)
    end(ping)
    await clock.advance(0)
    expect(pings).toEqual([4.5 * MINUTE])
  })

  test("stops once the wait passes the cap", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    keepAlive.begin("session")(ping)
    await clock.advance(MAX_WAIT_MS * 2)
    expect(pings).toHaveLength(Math.floor(MAX_WAIT_MS / PING_EVERY_MS))
    expect(pings.at(-1)).toBeLessThanOrEqual(MAX_WAIT_MS)
  })

  test("sends nothing while a call is out, and starts over from the next one", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    keepAlive.begin("session")(ping)
    await clock.advance(3 * MINUTE)
    const second = keepAlive.begin("session")
    await clock.advance(2 * MINUTE)
    expect(pings).toEqual([])
    second(ping)
    await clock.advance(4 * MINUTE)
    expect(pings).toEqual([7 * MINUTE])
  })

  test("waits for every call of the session to end", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    const first = keepAlive.begin("session")
    const second = keepAlive.begin("session")
    first(ping)
    await clock.advance(5 * MINUTE)
    expect(pings).toEqual([])
    second(ping)
    await clock.advance(0)
    expect(pings).toEqual([5 * MINUTE])
  })

  test("never pings a session whose loop went idle, even when its call ends after", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    keepAlive.begin("finished")(ping)
    keepAlive.idle("finished")
    const stopped = keepAlive.begin("stopped")
    keepAlive.idle("stopped")
    stopped(ping)
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([])
  })

  test("ends a wait with no ping after a failed call or a compaction", async () => {
    const { clock, keepAlive, pings, ping } = setup()
    keepAlive.begin("session")(ping)
    await clock.advance(1 * MINUTE)
    keepAlive.begin("session")()
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([])
  })

  test("tries a failed ping once more, then stops the wait and arms again on the next call", async () => {
    const { clock, keepAlive, pings, ping } = setup("failed")
    keepAlive.begin("session")(ping)
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([4 * MINUTE, 4 * MINUTE + RETRY_AFTER_MS])
    keepAlive.begin("session")(ping)
    await clock.advance(4 * MINUTE)
    expect(pings).toEqual([4 * MINUTE, 4 * MINUTE + RETRY_AFTER_MS, 14 * MINUTE])
  })

  test("keeps pinging from a retry that the proxy took", async () => {
    const { clock, keepAlive } = setup()
    const pings: number[] = []
    const results: PingResult[] = ["failed", "kept"]
    const ping = async () => {
      pings.push(clock.now())
      return results.shift() ?? "kept"
    }
    keepAlive.begin("session")(ping)
    await clock.advance(9 * MINUTE)
    const retried = 4 * MINUTE + RETRY_AFTER_MS
    expect(pings).toEqual([4 * MINUTE, retried, retried + 4 * MINUTE])
  })

  test("does not retry when the cache would be gone before the retry", async () => {
    const { clock, keepAlive, pings, ping } = setup("failed")
    const end = keepAlive.begin("session")
    await clock.advance(4.9 * MINUTE)
    end(ping)
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([4.9 * MINUTE])
  })

  test("drops a pending retry when the next call starts", async () => {
    const { clock, keepAlive, pings, ping } = setup("failed")
    keepAlive.begin("session")(ping)
    await clock.advance(4 * MINUTE + 1_000)
    keepAlive.begin("session")
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([4 * MINUTE])
  })

  test("stops every ping once the proxy turns out not to know them", async () => {
    const { clock, keepAlive, pings, ping } = setup("unsupported")
    keepAlive.begin("first")(ping)
    await clock.advance(1 * MINUTE)
    keepAlive.begin("second")(ping)
    await clock.advance(3 * MINUTE)
    expect(pings).toEqual([4 * MINUTE])
    keepAlive.begin("first")(ping)
    await clock.advance(10 * MINUTE)
    expect(pings).toEqual([4 * MINUTE])
  })

  test("reads the idle session from a status event", () => {
    expect(idleSession({ type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } })).toBe("s")
    expect(idleSession({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } })).toBe(
      undefined,
    )
    expect(idleSession({ type: "session.idle", properties: { sessionID: "s" } })).toBe(undefined)
    expect(idleSession(undefined)).toBe(undefined)
  })

  test("re-sends a finished generation as a one-token ping that reaches nothing else", async () => {
    const assignment = {
      runID: "run-a",
      rootSessionID: "session-root",
      scopeID: "turn-a",
      assignmentID: "opaque-assignment",
      telemetry: true,
    } as const
    const registry = new AssignmentRegistry()
    registry.assign("session-root", assignment)
    const clock = manualClock()
    const keepAlive = new KeepAlive({ now: clock.now, schedule: (run, ms) => clock.schedule(run, ms) })
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const telemetryCalls: string[] = []
    const call = (classification: string) =>
      proxy(
        new Request("http://localhost/arena/openrouter/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": "session-root",
            "x-arena-request-id": "00000000-0000-4000-8000-000000000001",
            "x-arena-generation-classification": classification,
          },
          body: JSON.stringify({
            model: "contestant",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "function", function: { name: "read" } }],
            max_tokens: 32_000,
            stream: true,
          }),
        }),
        registry,
        {
          upstream: "https://unit.invalid",
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers)
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const body: Record<string, unknown> = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
            sent.push({ url, headers, body })
            if (headers.get(KEEP_ALIVE_HEADER)) {
              return new Response(null, { status: 204, headers: { [KEEP_ALIVE_HEADER]: "1" } })
            }
            return new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "Content-Type": "text/event-stream" } },
            )
          },
          telemetry: {
            start: () => void telemetryCalls.push("start"),
            complete: () => void telemetryCalls.push("complete"),
          },
          keepAlive,
        },
      )

    await (await call("generation")).text()
    const progress = streamProgress("session-root")
    await clock.advance(4 * MINUTE)

    expect(sent).toHaveLength(2)
    const [real, ping] = sent
    expect(ping.url).toBe(real.url)
    expect(ping.headers.get(KEEP_ALIVE_HEADER)).toBe("1")
    expect(ping.headers.get("X-Arena-Assignment-ID")).toBe("opaque-assignment")
    expect(ping.headers.has("X-Arena-Generation-ID")).toBe(false)
    expect(ping.body).toEqual({ ...real.body, max_tokens: 1 })
    expect(telemetryCalls).toEqual(["start", "complete"])
    expect(streamProgress("session-root")?.generationID).toBe(progress?.generationID)

    // A compaction replaces the prompt the ping would keep; a utility call is not the conversation.
    await (await call("compaction")).text()
    await clock.advance(10 * MINUTE)
    expect(sent).toHaveLength(3)
    await (await call("utility")).text()
    await clock.advance(10 * MINUTE)
    expect(sent).toHaveLength(4)
  })
})
