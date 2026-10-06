import { afterEach, describe, expect, test } from "bun:test"
import { rename } from "fs/promises"
import { registry, setStoreForTest } from "@/arena/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { arenaRequest, installOpenRouterStub, json, memoryStore } from "./harness"

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  delete process.env.OPENROUTER_API_KEY
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("Arena checkout cleanup endpoints", () => {
  test("claims an idle checkout, blocks a new Arena chat, then releases it", async () => {
    await using directory = await tmpdir({ git: true })
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    const request = arenaRequest
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const payload = JSON.stringify({ root: directory.path })

    const inspected = await json<{ eligible: boolean; lastActivityAt: string | null }>(
      await request("/arena/checkout/inspect", { method: "POST", headers, body: payload }),
    )
    expect(inspected).toEqual({ eligible: true, lastActivityAt: null })

    const prepared = await request("/arena/checkout/prepare", { method: "POST", headers, body: payload })
    expect(prepared.status).toBe(204)

    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Eviction claim" }),
      }),
    )
    const blocked = await request(`/arena/sessions/${source.id}`, { method: "GET", headers })
    expect(blocked.status).toBe(400)
    expect(await blocked.text()).toContain("checkout")

    const released = await request("/arena/checkout/release", { method: "POST", headers, body: payload })
    expect(released.status).toBe(204)
    const attached = await json<{ chat: { id: string; status: string } }>(
      await request(`/arena/sessions/${source.id}`, { method: "GET", headers }),
    )
    expect(attached.chat.status).toBe("ready")

    const reclaimed = await request("/arena/checkout/prepare", { method: "POST", headers, body: payload })
    expect(reclaimed.status).toBe(204)
    const router = installOpenRouterStub()
    const refused = await request(`/arena/chats/${attached.chat.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "must remain blocked" }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("checkout")
    expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
    router.restore()
    await request("/arena/checkout/release", { method: "POST", headers, body: payload })
  })

  test("rejects inspection and preparation while an Arena chat is active", async () => {
    await using directory = await tmpdir({ git: true })
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    const request = arenaRequest
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Active cleanup guard" }),
      }),
    )
    const attached = await json<{ chat: { id: string } }>(
      await request(`/arena/sessions/${source.id}`, { method: "GET", headers }),
    )
    await memory.store.updateChat({ _id: attached.chat.id }, { $set: { status: "battle_active" } })

    const payload = JSON.stringify({ root: directory.path })
    const inspected = await json<{ eligible: boolean; reason?: string }>(
      await request("/arena/checkout/inspect", { method: "POST", headers, body: payload }),
    )
    expect(inspected.eligible).toBe(false)
    expect(inspected.reason).toContain("active")

    const prepared = await request("/arena/checkout/prepare", { method: "POST", headers, body: payload })
    expect(prepared.status).toBe(400)
    expect(await prepared.text()).toContain("cannot be evicted")
  })

  test("keeps an evicted chat ready while its canonical Git path is unavailable", async () => {
    await using directory = await tmpdir({ git: true })
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    const request = arenaRequest
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Missing canonical path" }),
      }),
    )
    const attached = await json<{ chat: { id: string; status: string } }>(
      await request(`/arena/sessions/${source.id}`, { method: "GET", headers }),
    )
    expect(attached.chat.status).toBe("ready")
    const payload = JSON.stringify({ root: directory.path })
    expect((await request("/arena/checkout/prepare", { method: "POST", headers, body: payload })).status).toBe(204)

    const hiddenGitDirectory = `${directory.path}/.git.arena-unavailable`
    await rename(`${directory.path}/.git`, hiddenGitDirectory)
    try {
      const history = await json<{ chat: { status: string } }>(
        await request(`/arena/sessions/${source.id}`, { method: "GET", headers }),
      )
      expect(history.chat.status).toBe("ready")
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
    } finally {
      await rename(hiddenGitDirectory, `${directory.path}/.git`)
      await request("/arena/checkout/release", { method: "POST", headers, body: payload })
    }
  })
})
