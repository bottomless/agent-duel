import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

type Completion = {
  readonly side: string
  readonly role: "parent-start" | "parent-idle" | "parent-reply" | "parent-woken" | "child"
  readonly messages: string
}

const stream = (delta: object, finish: string) =>
  new Response(
    `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

const text = (content: string) => stream({ role: "assistant", content }, "stop")

const subagentCall = () =>
  stream(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_child",
          type: "function",
          function: {
            name: "subagent",
            arguments: JSON.stringify({
              agent: "general",
              description: "Background child",
              prompt: "Do the slow part.",
              background: true,
            }),
          },
        },
      ],
    },
    "tool_calls",
  )

describe("Arena background child agents", () => {
  let originalFetch: typeof globalThis.fetch | undefined
  let home: string | undefined
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
  })

  /**
   * A battle against a scripted model. A parent starts one background child and ends its response.
   * The child's model request stays open until `releaseChildren`, so the child is working for as
   * long as a test needs it to be. The parent of `answerAtOnce` starts no child.
   */
  const battle = async (options: { readonly answerAtOnce?: "a" | "b" } = {}) => {
    const [{ Server }, credentials] = await Promise.all([import("@/server/server"), import("@/arena/credentials")])
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-children-home-"))
    const directory = await mkdtemp(path.join(home, "workspace-"))
    await $`git init`.cwd(directory).quiet()
    await $`git config user.email test@example.com`.cwd(directory).quiet()
    await $`git config user.name test`.cwd(directory).quiet()
    await writeFile(path.join(directory, "README.md"), "arena\n")
    await writeFile(path.join(directory, "opencode.json"), "{}\n")
    await $`git add README.md opencode.json`.cwd(directory).quiet()
    await $`git commit -m initial`.cwd(directory).quiet()

    const completions: Completion[] = []
    let releaseChildren = () => {}
    const childrenReleased = new Promise<void>((resolve) => {
      releaseChildren = resolve
    })
    let assignmentCount = 0
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.origin !== "https://control.test") return originalFetch!(input, init)
      const request = new Request(input, init)
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
      if (url.pathname !== "/api/openrouter/api/v1/chat/completions") return originalFetch!(input, init)
      const body = (await request.json()) as { messages?: readonly unknown[]; tools?: readonly unknown[] }
      // Native root sessions also request a title, which carries no tools.
      if (!body.tools?.length) return text("Battle title")
      const messages = JSON.stringify(body.messages ?? [])
      const side = /generation-\d+-([ab])/.exec(messages)?.[1] ?? "unknown"
      if (messages.includes("You are a subagent spawned by another session")) {
        completions.push({ side, role: "child", messages })
        await Promise.race([
          childrenReleased,
          new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
        ])
        return text("child finished")
      }
      if (side === options.answerAtOnce) return text("answered without a child")
      if (messages.includes("Reply while the child works.") && !messages.includes("<subagent sessionID")) {
        completions.push({ side, role: "parent-reply", messages })
        return text("answered the reply")
      }
      if (messages.includes("<subagent sessionID")) {
        completions.push({ side, role: "parent-woken", messages })
        return text("final answer after the child")
      }
      if (messages.includes("call_child")) {
        completions.push({ side, role: "parent-idle", messages })
        return text("I started a child and will wait for its report.")
      }
      completions.push({ side, role: "parent-start", messages })
      return subagentCall()
    }) as typeof globalThis.fetch

    const controlToken = "v2-children-token"
    credentials.setArenaCredentials({
      mode: "hosted",
      token: "test-token",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: credentials.hashArenaControlToken(controlToken),
    })
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    const app = Server.Default().app
    const call = (route: string, init?: RequestInit) =>
      app.request(route, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-paseo-control-token": controlToken,
          "x-opencode-directory": directory,
          ...(init?.headers ?? {}),
        },
      })
    const created = await call("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory }, model: { providerID: "arena", id: "medium" } }),
    })
    expect(created.status).toBe(200)
    const source = (await created.json()).data as { id: string }
    const attached = await call(`/arena/sessions/${source.id}`)
    expect(attached.status).toBe(200)
    const { chat } = (await attached.json()) as { chat: { id: string } }
    const started = await call(`/arena/chats/${chat.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Start a background child, then report." }),
    })
    expect(started.status).toBe(200)
    await started.text()

    type Snapshot = {
      runs?: readonly {
        id: string
        side: "a" | "b"
        sessionID: string
        runState: string
        error?: string
      }[]
      turn?: { id: string; state: string; canVote?: boolean }
    }
    const snapshot = async () => (await (await call(`/arena/sessions/${source.id}`)).json()) as Snapshot
    const until = async (done: (current: Snapshot) => boolean, what: string, timeout = 30_000) => {
      const deadline = Date.now() + timeout
      let current = await snapshot()
      while (Date.now() < deadline && !done(current)) {
        await Bun.sleep(50)
        current = await snapshot()
      }
      if (!done(current)) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(current.turn)}`)
      return current
    }
    const exportedMessages = async (sessionID: string) => {
      const exported = await call(`/api/experimental/session/${sessionID}/export`)
      expect(exported.status).toBe(200)
      return JSON.stringify(((await exported.json()) as { data?: { messages?: readonly unknown[] } }).data?.messages)
    }
    const running = () => completions.filter((completion) => completion.role === "child").length
    return { call, completions, exportedMessages, releaseChildren, running, snapshot, until }
  }

  const occurrences = (text: string, part: string) => text.split(part).length - 1

  test("a side waits for its children and each result arrives once", async () => {
    const { completions, exportedMessages, releaseChildren, running, snapshot, until } = await battle()
    await until(() => running() === 2, "both children to start")
    await until(
      () => completions.filter((completion) => completion.role === "parent-idle").length === 2,
      "both parents to end their responses",
    )
    // Both parents are idle and their children work. The battle stays open.
    await Bun.sleep(1_500)
    const waiting = await snapshot()
    expect(waiting.turn?.state).toBe("running")

    releaseChildren()
    const done = await until((current) => current.turn?.state === "awaiting_vote", "the vote")
    expect(done.turn?.canVote).toBe(true)
    expect(done.runs?.length).toBe(2)
    for (const run of done.runs ?? []) {
      expect(run.error).toBeUndefined()
      expect(run.runState).toBe("complete")
      const messages = await exportedMessages(run.sessionID)
      expect(occurrences(messages, 'state=\\"completed\\"')).toBe(1)
      expect(messages).toContain("final answer after the child")
    }
    // Each parent ran once more for its child's result, and only once.
    expect(completions.filter((completion) => completion.role === "parent-woken").length).toBe(2)
  }, 60_000)

  test("a reply reaches a parent that waits for its child", async () => {
    const { call, completions, releaseChildren, running, snapshot, until } = await battle()
    await until(() => running() === 2, "both children to start")
    const before = await until(
      () => completions.filter((completion) => completion.role === "parent-idle").length === 2,
      "both parents to end their responses",
    )
    const replied = await call(`/arena/turns/${before.turn?.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply while the child works.", target: "both" }),
    })
    expect(replied.status).toBe(200)
    await replied.text()
    await until(
      () => completions.filter((completion) => completion.role === "parent-reply").length === 2,
      "both parents to answer the reply",
    )
    await Bun.sleep(500)
    expect((await snapshot()).turn?.state).toBe("running")
    releaseChildren()
    const done = await until((current) => current.turn?.state === "awaiting_vote", "the vote")
    for (const run of done.runs ?? []) expect(run.runState).toBe("complete")
    expect(completions.filter((completion) => completion.role === "parent-woken").length).toBe(2)
  }, 60_000)

  test("Stop cancels the children without waking the parents", async () => {
    const { call, completions, exportedMessages, running, until } = await battle()
    await until(() => running() === 2, "both children to start")
    const before = await until(
      () => completions.filter((completion) => completion.role === "parent-idle").length === 2,
      "both parents to end their responses",
    )
    const stopped = await call(`/arena/turns/${before.turn?.id}/stop`, { method: "POST", body: "{}" })
    expect(stopped.status).toBe(200)
    await stopped.text()
    const after = await until(
      (current) => current.turn?.state !== "running" && current.turn?.state !== "stopping",
      "the stopped battle to settle",
    )
    // Long enough for a woken parent to reach the model.
    await Bun.sleep(1_000)
    expect(completions.filter((completion) => completion.role === "parent-woken")).toEqual([])
    for (const run of after.runs ?? []) {
      expect(run.runState).toBe("stopped")
      expect(occurrences(await exportedMessages(run.sessionID), 'state=\\"cancelled\\"')).toBe(1)
    }
  }, 60_000)

  test("an early vote cancels the other side's children without waking its parent", async () => {
    const { call, completions, running, until } = await battle({ answerAtOnce: "a" })
    await until(() => running() === 1, "the child to start")
    const finished = await until(
      (current) => current.runs?.find((run) => run.side === "a")?.runState === "complete",
      "side A to finish",
    )
    expect(finished.turn?.state).toBe("running")
    // The run reads as complete a moment before its result can be selected.
    let voted = new Response(null, { status: 400 })
    const voteDeadline = Date.now() + 10_000
    while (voted.status !== 200 && Date.now() < voteDeadline) {
      voted = await call(`/arena/turns/${finished.turn?.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ vote: "a" }),
      })
      await voted.text()
      if (voted.status !== 200) await Bun.sleep(100)
    }
    expect(voted.status).toBe(200)
    const after = await until(
      (current) => current.runs?.find((run) => run.side === "b")?.runState !== "pending",
      "side B to settle",
    )
    await Bun.sleep(1_000)
    expect(completions.filter((completion) => completion.role === "parent-woken")).toEqual([])
    expect(after.runs?.find((run) => run.side === "b")?.runState).toBe("stopped")
  }, 60_000)
})
