import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

describe("Arena v2 battle integration", () => {
  let originalFetch: typeof globalThis.fetch | undefined
  let home: string | undefined
  let directory: string | undefined
  const previousArena = process.env.OPENCODE_ARENA
  const previousHome = process.env.PASEO_HOME

  afterEach(async () => {
    if (originalFetch) globalThis.fetch = originalFetch
    originalFetch = undefined
    const [{ ArenaRuntime }, credentials] = await Promise.all([
      import("@/arena/runtime"),
      import("@/arena/credentials"),
    ])
    await ArenaRuntime.closeStore()
    credentials.setArenaCredentials(undefined)
    if (previousArena === undefined) delete process.env.OPENCODE_ARENA
    else process.env.OPENCODE_ARENA = previousArena
    if (previousHome === undefined) delete process.env.PASEO_HOME
    else process.env.PASEO_HOME = previousHome
    if (home) await rm(home, { recursive: true, force: true })
    home = undefined
    directory = undefined
  })

  test("grafts a voted winner, then accepts a filtered partial reply without counting a vote", async () => {
    const [{ Server }, { ArenaRuntime }, credentials] = await Promise.all([
      import("@/server/server"),
      import("@/arena/runtime"),
      import("@/arena/credentials"),
    ])
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-battle-home-"))
    directory = await mkdtemp(path.join(home, "workspace-"))
    await $`git init`.cwd(directory).quiet()
    await $`git config user.email test@example.com`.cwd(directory).quiet()
    await $`git config user.name test`.cwd(directory).quiet()
    await writeFile(path.join(directory, "README.md"), "arena\n")
    await writeFile(path.join(directory, "opencode.json"), "{}\n")
    await $`git add README.md opencode.json`.cwd(directory).quiet()
    await $`git commit -m initial`.cwd(directory).quiet()

    let assignmentCount = 0
    const completionRequests: Array<{
      readonly sessionID: string
      readonly messages: readonly unknown[]
      readonly response: string
    }> = []
    const responseBySession = new Map<string, string>()
    // The next turn receives one refusal of each kind. Keep the calls per assignment to catch retries.
    const blockedCalls: string[] = []
    let blockNextTurn = false
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.origin === "https://control.test") {
        const request = new Request(input, init)
        if (url.pathname === "/api/research") {
          const batch = (await request.json()) as { records: unknown[] }
          return Response.json({ received: batch.records.length, stored: batch.records.length })
        }
        if (url.pathname === "/api/arena/assignments") {
          const body = (await request.json()) as { action: string; kind: string; decision?: string }
          if (body.action === "create") {
            assignmentCount++
            return Response.json({
              assignments:
                body.kind === "battle"
                  ? [{ assignmentID: `a-${assignmentCount}` }, { assignmentID: `b-${assignmentCount}` }]
                  : [{ assignmentID: `s-${assignmentCount}` }],
            })
          }
          return Response.json({
            decision: body.decision,
            assignments: [
              { assignmentID: `a-${assignmentCount}`, model: "model-a" },
              { assignmentID: `b-${assignmentCount}`, model: "model-b" },
            ],
          })
        }
        if (url.pathname === "/api/arena/comparison")
          return Response.json({ provider: "test", choices: [{ message: { content: "comparison" } }] })
        if (url.pathname === "/api/openrouter/api/v1/chat/completions") {
          const completion = new Request(input, init)
          const arenaSessionID = completion.headers.get("x-arena-session-id") ?? completion.headers.get("x-session-id")
          const sessionID = arenaSessionID ?? `request-${completionRequests.length}`
          const body = (await completion.json()) as { messages?: readonly unknown[]; tools?: readonly unknown[] }
          // Native root sessions may also request a title. Keep each session's
          // response stable without assuming those auxiliary calls arrive last.
          const response = responseBySession.get(sessionID) ?? `response for ${sessionID}`
          responseBySession.set(sessionID, response)
          completionRequests.push({ sessionID, messages: body.messages ?? [], response })
          if (blockNextTurn && body.tools?.length) {
            const assignment = completion.headers.get("X-Arena-Assignment-ID")!
            blockedCalls.push(assignment)
            if (assignment !== blockedCalls[0]) {
              return Response.json(
                { error: { type: "content_filter", message: "private policy detail" } },
                { status: 400 },
              )
            }
            return new Response(
              'data: {"choices":[{"index":0,"delta":{"content":"Saved partial reply"},"finish_reason":"content_filter","native_finish_reason":"private policy detail"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            )
          }
          return new Response(
            `data: {"id":"r","choices":[{"index":0,"delta":{"role":"assistant","content":"${response}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
      }
      return originalFetch!(input, init)
    }) as typeof globalThis.fetch
    const controlToken = "v2-battle-token"
    credentials.setArenaCredentials({
      mode: "hosted",
      token: "test-token",
      controlPlaneUrl: "https://control.test",
      researchAccountID: "test-account",
      researchPartition: "test-partition",
      controlTokenHash: credentials.hashArenaControlToken(controlToken),
    })
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    const app = Server.Default().app
    const request = (route: string, init?: RequestInit) =>
      app.request(route, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-paseo-control-token": controlToken,
          ...(init?.headers ?? {}),
        },
      })

    const created = await request("/api/session", {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({
        location: { directory },
        model: { providerID: "arena", id: "medium" },
      }),
    })
    expect(created.status).toBe(200)
    const source = (await created.json()).data as { id: string }
    const attached = await request(`/arena/sessions/${source.id}`, {
      headers: { "x-opencode-directory": directory },
    })
    if (!attached.ok) throw new Error(await attached.text())
    expect(attached.status).toBe(200)
    const attachedBody = (await attached.json()) as { chat: { id: string } }
    const started = await request(`/arena/chats/${attachedBody.chat.id}/turns`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ prompt: "Run both contestants." }),
    })
    expect(started.status).toBe(200)
    await started.text()

    const snapshot = async () => {
      const response = await request(`/arena/sessions/${source.id}`, {
        headers: { "x-opencode-directory": directory },
      })
      return (await response.json()) as {
        chat: { id: string; canonicalSessionID: string; activeTurnID?: string }
        runs?: readonly { side: "a" | "b"; sessionID: string; messages?: readonly unknown[] }[]
        turn?: { id: string; state: string; selectableSides?: string[] }
      }
    }
    let current = await snapshot()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && current.turn?.state !== "awaiting_vote" && current.turn?.state !== "discarded") {
      await Bun.sleep(100)
      current = await snapshot()
    }
    expect(current.turn?.state).toBe("awaiting_vote")
    // A first turn has no warm pair, so both sides are cold. Each must run its first step in its own
    // worktree: Core gives tools, the shell, and child agents the session's location at that step.
    const workingDirectories = completionRequests.flatMap((completion) =>
      [...JSON.stringify(completion.messages).matchAll(/Working directory: ([^\\"]+)/g)].map((match) => match[1]),
    )
    expect(workingDirectories.length).toBeGreaterThanOrEqual(2)
    for (const workingDirectory of workingDirectories)
      expect(workingDirectory).toContain(`${path.sep}.agent-duel${path.sep}worktrees${path.sep}`)
    const contestantRuns = current.runs ?? []
    expect(contestantRuns.length).toBe(2)
    const responseByRun = new Map<string, string>()
    for (const run of contestantRuns) {
      const info = await request(`/api/session/${run.sessionID}`, {
        headers: { "x-opencode-directory": directory },
      })
      expect(info.status).toBe(200)
      const session = (await info.json()) as { data?: { parentID?: string } }
      // Arena contestants are native roots. A synthetic canonical parent would
      // consume Core's default subagent depth before the contestant can delegate.
      expect(session.data?.parentID).toBeUndefined()
      const exported = await request(`/api/experimental/session/${run.sessionID}/export`, {
        headers: { "x-opencode-directory": directory },
      })
      expect(exported.status).toBe(200)
      const body = (await exported.json()) as { data?: { messages?: readonly unknown[] } }
      const text = [...responseBySession.values()].find((candidate) =>
        JSON.stringify(body.data?.messages ?? []).includes(candidate),
      )
      if (text) responseByRun.set(run.sessionID, text)
    }
    const turnID = current.turn?.id
    if (!turnID) throw new Error("Arena did not publish a turn ID")
    const voted = await request(`/arena/turns/${turnID}/vote`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ vote: "a" }),
    })
    expect(voted.status).toBe(200)
    await voted.text()
    current = await snapshot()
    const graftDeadline = Date.now() + 30_000
    while (Date.now() < graftDeadline && current.chat.activeTurnID) {
      await Bun.sleep(100)
      current = await snapshot()
    }
    expect(current.chat.activeTurnID).toBeUndefined()

    const winnerRun = current.runs?.find((run) => run.side === "a")
    const loserRun = current.runs?.find((run) => run.side === "b")
    if (!winnerRun || !loserRun) throw new Error("Arena run sessions were not published")
    const winnerText = responseByRun.get(winnerRun.sessionID)
    const loserText = responseByRun.get(loserRun.sessionID)
    if (!winnerText || !loserText) throw new Error("Contestant completion responses were not recorded")
    expect(winnerText).not.toBe(loserText)

    const exported = await request(`/api/experimental/session/${current.chat.canonicalSessionID}/export`, {
      headers: { "x-opencode-directory": directory },
    })
    expect(exported.status).toBe(200)
    const exportedBody = (await exported.json()) as { data?: { messages?: readonly unknown[] } }
    const canonicalHistory = JSON.stringify(exportedBody.data?.messages ?? [])
    expect(canonicalHistory).toContain(winnerText)
    expect(canonicalHistory).toContain("Run both contestants.")
    expect(canonicalHistory).not.toContain(loserText)

    const requestsBeforeNextTurn = completionRequests.length
    blockNextTurn = true
    const next = await request(`/arena/chats/${current.chat.id}/turns`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ prompt: "Continue after the vote." }),
    })
    expect(next.status).toBe(200)
    await next.text()
    let afterNext = await snapshot()
    const nextDeadline = Date.now() + 20_000
    while (
      Date.now() < nextDeadline &&
      afterNext.turn?.state !== "awaiting_vote" &&
      afterNext.turn?.state !== "discarded"
    ) {
      await Bun.sleep(100)
      afterNext = await snapshot()
    }
    expect(afterNext.turn?.state).toBe("awaiting_vote")
    const nextRequests = completionRequests.slice(requestsBeforeNextTurn)
    expect(nextRequests.length).toBeGreaterThan(0)
    const nextPrompt = JSON.stringify(nextRequests.flatMap((request) => request.messages))
    expect(nextPrompt).toContain(winnerText)
    expect(nextPrompt).toContain("Continue after the vote.")

    const nextTurnID = afterNext.turn?.id
    if (!nextTurnID) throw new Error("Arena did not publish the replay turn ID")
    expect(blockedCalls).toHaveLength(2)
    expect(new Set(blockedCalls).size).toBe(2)
    expect(afterNext.turn).toMatchObject({ canTie: false })
    for (const run of afterNext.runs ?? []) {
      expect(run).toMatchObject({
        runState: "error",
        error: "A content filter blocked this response.",
        selectable: false,
        canRetry: false,
        canAcceptFailed: true,
      })
    }
    expect(JSON.stringify(afterNext)).not.toContain("private policy detail")
    const filteredSessions = await Promise.all(
      (afterNext.runs ?? []).map(async (run) => {
        const history = await request(`/api/experimental/session/${run.sessionID}/export`, {
          headers: { "x-opencode-directory": directory! },
        })
        expect(history.status).toBe(200)
        const text = await history.text()
        expect(text).not.toContain("private policy detail")
        return { side: run.side, partial: text.includes("Saved partial reply") }
      }),
    )
    const partial = filteredSessions.find((session) => session.partial)
    if (!partial) throw new Error("Missing partial response from the filtered side")
    const accepted = await request(`/arena/turns/${nextTurnID}/vote`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ vote: partial.side, acceptFailed: true }),
    })
    expect(accepted.status).toBe(200)
    expect((await accepted.json()).turn).toMatchObject({
      acceptedFailedSide: partial.side,
      voteDiscardedReason: "contestant_failed",
    })
    const appliedDeadline = Date.now() + 20_000
    while (Date.now() < appliedDeadline && afterNext.chat.activeTurnID) {
      await Bun.sleep(100)
      afterNext = await snapshot()
    }
    expect(afterNext.chat.activeTurnID).toBeUndefined()
    const kept = await request(`/api/experimental/session/${afterNext.chat.canonicalSessionID}/export`, {
      headers: { "x-opencode-directory": directory },
    })
    expect(kept.status).toBe(200)
    expect(await kept.text()).toContain("Saved partial reply")
  }, 45_000)
})
