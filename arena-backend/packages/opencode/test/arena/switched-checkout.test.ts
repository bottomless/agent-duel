import { $ } from "bun"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Snapshot } from "@/arena/schema"

// The developer starts a battle on X, a branch ahead of main, and switches the checkout to main
// while the contestants work. At the vote Arena asks where the winner goes: replaying only the
// battle's commits onto main, or switching back to X and applying there. Before this question,
// applying measured the winner's files against main and carried X's own history onto main.

const git = "git -c user.name=test -c user.email=test@example.com"
const newFile = `printf 'work\\n' > work.txt && git add work.txt && ${git} commit -qm work`
// X added "b" after "a"; appending "c" next to it cannot replay onto main, which has only "a".
const nextToX = `printf 'c\\n' >> notes.txt && ${git} commit -qam work`

function stream(delta: object, finish: string) {
  const chunk = {
    id: "response",
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: finish }],
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function shell(command: string) {
  return stream(
    {
      tool_calls: [
        {
          index: 0,
          id: `call_${Bun.hash(command)}`,
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command, description: "Run git" }) },
        },
      ],
    },
    "tool_calls",
  )
}

type Outcome = {
  directory: string
  startMain: string
  startX: string
  item: Extract<NonNullable<NonNullable<Snapshot["turn"]>["gitApplication"]>["review"], object>["items"][number]
  turn: NonNullable<Snapshot["turn"]>
}

async function battle(command: string, choice: "move" | "stay", check: (outcome: Outcome) => Promise<void>) {
  const [{ Server }, credentials, { ArenaRuntime }] = await Promise.all([
    import("@/server/server"),
    import("@/arena/credentials"),
    import("@/arena/runtime"),
  ])
  const originalFetch = globalThis.fetch
  const previousArena = process.env.OPENCODE_ARENA
  const previousHome = process.env.PASEO_HOME
  const previousDb = process.env.OPENCODE_DB
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "arena-switched-checkout-")))
  try {
    const directory = await mkdtemp(path.join(home, "repo-"))
    await $`git init -q -b main`.cwd(directory).quiet()
    await Bun.write(path.join(directory, "opencode.json"), "{}\n")
    await Bun.write(path.join(directory, "notes.txt"), "a\n")
    await $`git add opencode.json notes.txt`.cwd(directory).quiet()
    await $`git -c user.name=test -c user.email=test@example.com commit -qm initial`.cwd(directory).quiet()
    await $`git checkout -q -b X`.cwd(directory).quiet()
    await Bun.write(path.join(directory, "notes.txt"), "a\nb\n")
    await $`git -c user.name=test -c user.email=test@example.com commit -qam "ahead of main"`.cwd(directory).quiet()
    const startX = (await $`git rev-parse X`.cwd(directory).text()).trim()
    const startMain = (await $`git rev-parse main`.cwd(directory).text()).trim()

    const controlPlaneUrl = "https://control.test"
    let switched = false
    globalThis.fetch = (async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (url.origin === controlPlaneUrl) {
        switch (url.pathname) {
          case "/api/arena/assignments": {
            const { action, decision } = (await req.json()) as { action: string; decision?: string }
            if (action === "resolve")
              return Response.json({
                decision,
                assignments: [
                  { assignmentID: "side-1", model: "model-1" },
                  { assignmentID: "side-2", model: "model-2" },
                ],
              })
            return Response.json({ assignments: [{ assignmentID: "side-1" }, { assignmentID: "side-2" }] })
          }
          case "/api/research": {
            const { records } = (await req.json()) as { records: unknown[] }
            return Response.json({ received: records.length, stored: records.length })
          }
          case "/api/arena/comparison":
            return Response.json({ provider: "test", choices: [{ message: { content: "Title: Switched" } }] })
          case "/api/openrouter/api/v1/chat/completions": {
            const body = (await req.json()) as { tools?: unknown[]; messages: { role: string }[] }
            if (!body.tools?.length) return stream({ content: "Battle title" }, "stop")
            // The contestants are at work in their own worktrees: the developer moves the checkout.
            if (!switched) {
              switched = true
              Bun.spawnSync(["git", "checkout", "-q", "main"], { cwd: directory })
            }
            if (body.messages.at(-1)?.role === "tool") return stream({ content: "Done" }, "stop")
            return shell(command)
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
    })
    const { chat } = await request<Snapshot>(`/arena/sessions/${data.id}`)
    const { turn } = await request<Snapshot>(`/arena/chats/${encodeURIComponent(chat.id)}/turns`, {
      prompt: "Commit the work on this branch.",
      autoAccept: true,
    })
    if (!turn) throw new Error("Battle was not admitted")
    const route = `/arena/turns/${encodeURIComponent(turn.id)}`
    async function until(label: string, ready: (snapshot: Snapshot) => boolean) {
      const deadline = Date.now() + 45_000
      let snapshot = await request<Snapshot>(route)
      while (!ready(snapshot)) {
        if (Date.now() >= deadline) {
          const states = snapshot.runs.map(({ side, runState, error }) => ({ side, runState, error }))
          throw new Error(
            `Timed out waiting for ${label}: ${snapshot.turn?.state} ${JSON.stringify(snapshot.turn?.gitApplication)} ${JSON.stringify(states)}`,
          )
        }
        await Bun.sleep(50)
        snapshot = await request<Snapshot>(route)
      }
      return snapshot
    }

    await until(
      "the settlement",
      (snapshot) =>
        snapshot.turn?.state === "awaiting_vote" &&
        snapshot.runs.length === 2 &&
        snapshot.runs.every((run) => run.runState === "complete" && run.selectable),
    )
    expect((await $`git branch --show-current`.cwd(directory).text()).trim()).toBe("main")

    await request(`${route}/vote`, { vote: "a" })
    const parked = await until("the review", (snapshot) => snapshot.turn?.gitApplication?.state === "review")
    // Nothing is written while the question stands.
    expect((await $`git rev-parse main X`.cwd(directory).text()).trim().split("\n")).toEqual([startMain, startX])
    const items = parked.turn!.gitApplication!.review!.items
    expect(items.map((item) => item.kind)).toEqual(["switched"])
    const item = items[0]!
    if (item.kind !== "switched") throw new Error("expected the switched question")
    expect([item.from, item.to]).toEqual(["X", "main"])

    await request(`${route}/retry-resolution`, {
      answers: [{ key: item.key, fingerprint: item.fingerprint, choice }],
    })
    const settled = await until(
      "the applied answer",
      (snapshot) =>
        snapshot.turn?.state === "complete" ||
        (snapshot.turn?.state === "application_failed" && snapshot.turn.gitApplication?.state !== "review"),
    )
    await check({ directory, startMain, startX, item, turn: settled.turn! })
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
}

test("moving the winner to the branch the checkout switched to replays only the battle's commits", async () => {
  await battle(newFile, "move", async ({ directory, startMain, startX, item, turn }) => {
    if (item.kind === "switched") expect(item.clash).toBeUndefined()
    expect(turn.state).toBe("complete")
    expect((await $`git branch --show-current`.cwd(directory).text()).trim()).toBe("main")
    expect((await $`git status --porcelain`.cwd(directory).text()).trim()).toBe("")
    expect((await $`git rev-parse X`.cwd(directory).text()).trim()).toBe(startX)
    expect((await $`git rev-parse main~1`.cwd(directory).text()).trim()).toBe(startMain)
    expect((await $`git log -1 --format=%s main`.cwd(directory).text()).trim()).toBe("work")
    expect(await $`git show main:work.txt`.cwd(directory).text()).toBe("work\n")
    // X's own commit stays off main.
    expect(await $`git show main:notes.txt`.cwd(directory).text()).toBe("a\n")
  })
}, 90_000)

test("switching back applies the winner on the branch the battle ran on", async () => {
  await battle(newFile, "stay", async ({ directory, startMain, startX, turn }) => {
    expect(turn.state).toBe("complete")
    expect((await $`git branch --show-current`.cwd(directory).text()).trim()).toBe("X")
    expect((await $`git status --porcelain`.cwd(directory).text()).trim()).toBe("")
    expect((await $`git rev-parse main`.cwd(directory).text()).trim()).toBe(startMain)
    expect((await $`git rev-parse X~1`.cwd(directory).text()).trim()).toBe(startX)
    expect(await $`git show X:work.txt`.cwd(directory).text()).toBe("work\n")
  })
}, 90_000)

test("a battle commit that cannot replay onto the new branch lands as conflict markers, not the winner's file", async () => {
  await battle(nextToX, "move", async ({ directory, startMain, startX, item, turn }) => {
    if (item.kind === "switched") expect(item.clash).toEqual(["notes.txt"])
    expect(turn.gitApplication?.state).toBe("conflicted")
    expect((await $`git branch --show-current`.cwd(directory).text()).trim()).toBe("main")
    expect((await $`git rev-parse main X`.cwd(directory).text()).trim().split("\n")).toEqual([startMain, startX])
    expect(await Bun.file(path.join(directory, "notes.txt")).text()).toContain("<<<<<<<")
  })
}, 90_000)
