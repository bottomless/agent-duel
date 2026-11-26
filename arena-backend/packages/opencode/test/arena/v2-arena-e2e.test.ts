import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { chatSlug, turnID as makeTurnID } from "@/arena/domain"
import type { TurnDocument } from "@/arena/records"

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

  // The draw answers `decided`, or the control plane predates that answer and the replay probe does.
  async function runsVotesGraftsAndAdmits(answersDecided: boolean) {
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
    const battleScopes: string[] = []
    // Scopes an earlier battle already decided on the control plane. The draw says so, or for an older
    // control plane only the replay route does, by refusing them.
    const decidedScopes = new Set<string>()
    const replayProbes: string[] = []
    const completionRequests: Array<{
      readonly sessionID: string
      readonly messages: readonly unknown[]
      readonly response: string
    }> = []
    const responseBySession = new Map<string, string>()
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.origin === "https://control.test") {
        const request = new Request(input, init)
        if (url.pathname === "/api/arena/assignments") {
          const body = (await request.json()) as { action: string; kind: string; scopeID: string; decision?: string }
          if (body.action === "create") {
            if (body.kind === "battle") battleScopes.push(body.scopeID)
            assignmentCount++
            return Response.json({
              assignments:
                body.kind === "battle"
                  ? [{ assignmentID: `a-${assignmentCount}` }, { assignmentID: `b-${assignmentCount}` }]
                  : [{ assignmentID: `s-${assignmentCount}` }],
              ...(answersDecided ? { decided: decidedScopes.has(body.scopeID) } : {}),
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
        if (url.pathname === "/api/openrouter/api/v1/arena/replay") {
          const scopeID = request.headers.get("x-arena-scope-id") ?? ""
          replayProbes.push(scopeID)
          return decidedScopes.has(scopeID)
            ? Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
            : Response.json(
                { error: { message: "Arena contestant response is not available", type: "arena_replay_unavailable" } },
                { status: 404 },
              )
        }
        if (url.pathname === "/api/arena/comparison")
          return Response.json({ provider: "test", choices: [{ message: { content: "comparison" } }] })
        if (url.pathname === "/api/openrouter/api/v1/chat/completions") {
          const completion = new Request(input, init)
          const arenaSessionID = completion.headers.get("x-arena-session-id") ?? completion.headers.get("x-session-id")
          const sessionID = arenaSessionID ?? `request-${completionRequests.length}`
          const body = (await completion.json()) as { messages?: readonly unknown[] }
          // Native root sessions may also request a title. Keep each session's
          // response stable without assuming those auxiliary calls arrive last.
          const response = responseBySession.get(sessionID) ?? `response for ${sessionID}`
          responseBySession.set(sessionID, response)
          completionRequests.push({ sessionID, messages: body.messages ?? [], response })
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
    expect(attached.status).toBe(200)
    const attachedBody = (await attached.json()) as { chat: { id: string } }
    // The chat counter was restored, but the checkout still holds the earlier turn 0's results.
    const legacyRoot = `refs/battles/${chatSlug(attachedBody.chat.id)}/turn-0`
    const older = (await $`git commit-tree HEAD^{tree} -m earlier-result`.cwd(directory).quiet().text()).trim()
    for (const name of ["a", "b", "selected"]) {
      await $`git update-ref ${`${legacyRoot}/${name}`} ${older}`.cwd(directory).quiet()
    }
    // An engine stopped between turn 1's insert and its activation left that record unactivated.
    const store = await ArenaRuntime.store()
    const orphanID = makeTurnID(attachedBody.chat.id, 1)
    const orphanRef = `refs/battles/${chatSlug(attachedBody.chat.id)}/turn-1-00000000-0000-4000-8000-000000000000/base`
    const head = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
    await $`git update-ref ${orphanRef} ${head}`.cwd(directory).quiet()
    await store.turns.insertOne({
      _id: orphanID,
      chatID: attachedBody.chat.id,
      turnIndex: 1,
      state: "creating",
      frozenBaseSHA: head,
      baseSnapshot: { canonicalHead: head, tree: "", indexTree: "", permanentRef: orphanRef },
    } as unknown as TurnDocument)
    // Index 2 left no record and no ref, but the control plane already decided its pair.
    const decidedID = makeTurnID(attachedBody.chat.id, 2)
    decidedScopes.add(decidedID)
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
    // The surviving turn-0 refs and the unactivated turn 1 claim their indexes locally; the decided
    // pair claims index 2, so the battle takes index 3: the logical turn ID also keys the hosted pair
    // draw, which must not hand back an old pair.
    expect(turnID).toBe(makeTurnID(attachedBody.chat.id, 3))
    expect(battleScopes).toEqual([decidedID, turnID])
    // A draw that answers `decided` leaves the start with no round trip of its own.
    if (answersDecided) expect(replayProbes).toEqual([])
    else expect(replayProbes.slice(0, 2)).toEqual([decidedID, turnID])
    expect(await store.turn(orphanID)).toBeNull()
    expect((await $`git rev-parse --verify --quiet ${orphanRef}`.cwd(directory).quiet().nothrow()).exitCode).toBe(1)
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
    for (const name of ["a", "b", "selected"]) {
      expect((await $`git rev-parse ${`${legacyRoot}/${name}`}`.cwd(directory).quiet().text()).trim()).toBe(older)
    }

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
    const cleaned = await request(`/arena/turns/${nextTurnID}/vote`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ vote: "a" }),
    })
    expect(cleaned.status).toBe(200)
    await cleaned.text()
    if (answersDecided) expect(replayProbes).toEqual([])
  }

  test(
    "runs two contestants, votes, grafts, and admits the next native prompt",
    () => runsVotesGraftsAndAdmits(true),
    45_000,
  )

  test(
    "runs two contestants, votes, grafts, and admits the next native prompt on a control plane without the decided answer",
    () => runsVotesGraftsAndAdmits(false),
    45_000,
  )
})
