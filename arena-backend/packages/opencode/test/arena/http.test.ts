import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  await disposeAllInstances()
})

describe("Arena HTTP wiring", () => {
  test("routes session resolution and turn admission through the Arena service", async () => {
    delete process.env.OPENCODE_ARENA
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }

    const session = await Server.Default().app.request("/arena/sessions/session", { headers })
    const start = await Server.Default().app.request("/arena/chats/chat/turns", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "test the Arena route" }),
    })
    const retry = await Server.Default().app.request("/arena/turns/turn/retry-resolution", {
      method: "POST",
      headers,
    })
    const reply = await Server.Default().app.request("/arena/turns/turn/reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "check the edge case", target: "both" }),
    })
    const fork = await Server.Default().app.request("/arena/sessions/session/fork", {
      method: "POST",
      headers,
      body: JSON.stringify({ destination: directory.path }),
    })
    const tree = await Server.Default().app.request("/arena/chats/chat/turns/turn/inspect/a/tree", { headers })
    const file = await Server.Default().app.request("/arena/chats/chat/turns/turn/inspect/b/file?path=src%2Findex.ts", {
      headers,
    })

    expect(session.status).toBe(400)
    expect(start.status).toBe(400)
    expect(retry.status).toBe(400)
    expect(reply.status).toBe(400)
    // The fork route needs no battle: it fails on the missing session, not on Arena mode.
    expect(fork.status).toBe(400)
    expect(await fork.text()).not.toContain("Arena mode is disabled")
    expect(tree.status).toBe(400)
    expect(file.status).toBe(400)
    expect(await session.text()).toContain("Arena mode is disabled")
    expect(await start.text()).toContain("Arena mode is disabled")
    expect(await retry.text()).toContain("Arena mode is disabled")
    expect(await reply.text()).toContain("Arena mode is disabled")
    expect(await tree.text()).toContain("Arena mode is disabled")
    expect(await file.text()).toContain("Arena mode is disabled")
  })
})
