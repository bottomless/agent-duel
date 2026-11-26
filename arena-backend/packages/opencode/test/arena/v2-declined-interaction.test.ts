import { $ } from "bun"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Snapshot } from "@/arena/schema"
import type { ArenaQuestionRequest } from "@/arena/session-runtime/schema"
import type { PermissionV1 } from "@opencode/schema/v1/permission"

const command = "echo arena_probe"
const question = {
  header: "Next step",
  question: "Which step should I take?",
  options: [{ label: "Continue", description: "Proceed with the task" }],
}

function stream(delta: object, finish: string) {
  const chunk = {
    id: "response",
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: finish }],
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function tool(name: string, input: object) {
  return stream(
    {
      tool_calls: [
        { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(input) } },
      ],
    },
    "tool_calls",
  )
}

test("declining the main contestant's question or shell permission leaves both results eligible for a vote", async () => {
  const [{ Server }, credentials, { ArenaRuntime }] = await Promise.all([
    import("@/server/server"),
    import("@/arena/credentials"),
    import("@/arena/runtime"),
  ])
  const originalFetch = globalThis.fetch
  const previousArena = process.env.OPENCODE_ARENA
  const previousHome = process.env.PASEO_HOME
  const previousDb = process.env.OPENCODE_DB
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "arena-declined-interaction-")))
  try {
    const directory = await mkdtemp(path.join(home, "repo-"))
    await $`git init -q -b main`.cwd(directory).quiet()
    await Bun.write(path.join(directory, "opencode.json"), "{}\n")
    await $`git add opencode.json`.cwd(directory).quiet()
    await $`git -c user.name=test -c user.email=test@example.com commit -qm initial`.cwd(directory).quiet()

    const controlPlaneUrl = "https://control.test"
    const contestantCalls: string[] = []
    globalThis.fetch = (async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (url.origin === controlPlaneUrl) {
        switch (url.pathname) {
          case "/api/arena/assignments":
            return Response.json({
              assignments: [{ assignmentID: "ask-question" }, { assignmentID: "ask-permission" }],
            })
          case "/api/research": {
            const { records } = (await req.json()) as { records: unknown[] }
            return Response.json({ received: records.length, stored: records.length })
          }
          case "/api/arena/comparison":
            return Response.json({
              provider: "test",
              choices: [{ message: { content: "Title: Declined interactions" } }],
            })
          case "/api/openrouter/api/v1/chat/completions": {
            const body = (await req.json()) as { tools?: unknown[]; messages: { role: string }[] }
            if (!body.tools?.length) return stream({ content: "Battle title" }, "stop")
            const assignment = req.headers.get("x-arena-assignment-id") ?? "unknown"
            contestantCalls.push(assignment)
            // End an unexpected continuation so it fails the call-count assertion rather than leaving another card pending.
            if (body.messages.at(-1)?.role === "tool") return stream({ content: "Done" }, "stop")
            if (assignment === "ask-question") return tool("question", { questions: [question] })
            if (assignment === "ask-permission")
              return tool("shell", { command, description: "Print the probe message" })
          }
        }
      }
      throw new Error(`Unexpected fetch: ${url.origin}${url.pathname}`)
    }) as typeof globalThis.fetch
    const controlToken = "test-control"
    credentials.setArenaCredentials({
      mode: "hosted",
      token: "test-token",
      controlPlaneUrl,
      researchPartition: "test",
      researchAccountID: "acct-test",
      controlTokenHash: credentials.hashArenaControlToken(controlToken),
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.PASEO_HOME = home
    delete process.env.OPENCODE_DB

    const app = Server.Default().app
    async function request<T>(route: string, body?: object): Promise<T> {
      const response = await app.request(route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": directory,
          "x-paseo-control-token": controlToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status !== 200) throw new Error(`${route} returned ${response.status}: ${await response.text()}`)
      return response.json() as Promise<T>
    }
    const { data } = await request<{ data: { id: string } }>("/api/session", {
      location: { directory },
      model: { providerID: "arena", id: "medium" },
      permissions: [{ action: "shell", resource: command, effect: "ask" }],
    })
    const { chat } = await request<Snapshot>(`/arena/sessions/${data.id}`)
    const { turn } = await request<Snapshot>(`/arena/chats/${encodeURIComponent(chat.id)}/turns`, {
      prompt: "Check before continuing.",
      autoAccept: false,
    })
    if (!turn) throw new Error("Battle was not admitted")
    const route = `/arena/turns/${encodeURIComponent(turn.id)}`
    async function until(label: string, ready: (snapshot: Snapshot) => boolean) {
      const deadline = Date.now() + 30_000
      let snapshot = await request<Snapshot>(route)
      while (!ready(snapshot)) {
        if (Date.now() >= deadline) {
          const states = snapshot.runs.map(({ side, runState, error, questions, permissions }) => ({
            side,
            runState,
            error,
            questions,
            permissions,
          }))
          throw new Error(`Timed out waiting for ${label}: ${snapshot.turn?.state} ${JSON.stringify(states)}`)
        }
        await Bun.sleep(50)
        snapshot = await request<Snapshot>(route)
      }
      return snapshot
    }
    const pending = await until(
      "both cards",
      ({ runs }) =>
        runs.some((r) => r.side === "a" && r.questions?.length === 1) &&
        runs.some((r) => r.side === "b" && r.permissions?.length === 1),
    )
    const a = pending.runs.find((run) => run.side === "a")!
    const b = pending.runs.find((run) => run.side === "b")!
    const form = a.questions![0] as ArenaQuestionRequest
    const permission = b.permissions![0] as PermissionV1.Request
    expect(form).toMatchObject({
      sessionID: a.sessionID,
      questions: [{ question: expect.stringContaining(question.question) }],
    })
    expect(permission).toMatchObject({ sessionID: b.sessionID, permission: "shell", patterns: [command] })
    await request(`/arena/runs/${encodeURIComponent(a.id)}/questions/${encodeURIComponent(form.id)}/reject`, {})
    await request(`/arena/runs/${encodeURIComponent(b.id)}/permissions/${encodeURIComponent(permission.id)}/reply`, {
      response: "reject",
    })

    const settled = await until("finalization", (snapshot) => snapshot.turn?.state === "awaiting_vote")
    const store = await ArenaRuntime.store()
    expect((await store.run(a.id))?.questionOutcomes).toEqual([
      { requestID: form.id, rejected: true, at: expect.any(Date) },
    ])
    expect((await store.run(b.id))?.permissionOutcomes).toEqual([
      { requestID: permission.id, response: "reject", at: expect.any(Date) },
    ])
    expect(settled.runs).toHaveLength(2)
    for (const run of settled.runs) {
      expect(run).toMatchObject({ runState: "complete", selectable: true, completedAt: expect.any(String) })
      expect(run.error).toBeUndefined()
    }
    expect(settled.turn?.canVote).toBe(true)
    expect(contestantCalls.sort()).toEqual(["ask-permission", "ask-question"])
  } finally {
    await ArenaRuntime.closeStore()
    credentials.setArenaCredentials(undefined)
    globalThis.fetch = originalFetch
    if (previousArena === undefined) delete process.env.OPENCODE_ARENA
    else process.env.OPENCODE_ARENA = previousArena
    if (previousHome === undefined) delete process.env.PASEO_HOME
    else process.env.PASEO_HOME = previousHome
    if (previousDb === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previousDb
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
