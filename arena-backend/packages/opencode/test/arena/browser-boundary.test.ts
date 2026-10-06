import { afterEach, describe, expect, test } from "bun:test"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { closeStore, registry, setStoreForTest } from "@/arena/runtime"
import { Server } from "@/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const controlToken = "private-control-token"

function app() {
  return Server.Default().app
}

function enableArena() {
  process.env.OPENCODE_ARENA = "1"
  setArenaCredentials({
    mode: "hosted",
    token: "private-runtime-token",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken(controlToken),
  })
}

function headers(directory: string, token?: string) {
  return {
    "content-type": "application/json",
    "x-opencode-directory": directory,
    ...(token ? { "x-paseo-control-token": token } : {}),
  }
}

async function createSession(directory: string) {
  const response = await app().request("/session", {
    method: "POST",
    headers: headers(directory, controlToken),
    body: JSON.stringify({ title: "Arena canonical" }),
  })
  expect(response.status).toBe(200)
  const value = await response.json()
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Session response did not contain an ID")
  }
  return value.id
}

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  delete process.env.OPENCODE_ARENA_ENABLE_DOCS
  delete process.env.PASEO_OPENCODE_CONTROL_TOKEN
  delete process.env.PASEO_CONTROL_PLANE_URL
  delete process.env.PASEO_ARENA_SESSION_TOKEN
  setArenaCredentials(undefined)
  await closeStore()
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("Arena local HTTP boundary", () => {
  test("hides documentation unless it is explicitly enabled", async () => {
    enableArena()

    expect((await app().request("/doc")).status).toBe(404)
    expect(
      (
        await app().request("/doc", {
          headers: { "x-paseo-control-token": controlToken },
        })
      ).status,
    ).toBe(404)

    process.env.OPENCODE_ARENA_ENABLE_DOCS = "1"
    expect((await app().request("/doc")).status).toBe(200)
  })

  test("defaults to deny while retaining only liveness", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    enableArena()
    const publicHeaders = headers(directory.path)

    expect((await app().request("/global/health", { headers: publicHeaders })).status).toBe(200)

    const blocked = await Promise.all(
      [
        ["GET", "/"],
        ["GET", "/api/health"],
        ["GET", "/project"],
        ["GET", "/file"],
        ["GET", "/experimental/worktree"],
        ["POST", "/experimental/worktree"],
        ["GET", "/arena/activity"],
        ["POST", "/arena/activity"],
        ["GET", "/api/fs/list?path=."],
        ["GET", "/api/fs/find?query=&type=directory&limit=10"],
        ["POST", "/api/fs/list"],
        ["POST", "/api/fs/find"],
      ].map(([method, path]) =>
        app().request(path!, {
          method,
          headers: publicHeaders,
          body: method === "GET" ? undefined : "{}",
        }),
      ),
    )

    for (const response of blocked) {
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
    }
  })

  test("requires the daemon token for every session read and mutation before parsing input", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    enableArena()
    const sessionRoutes = [
      ["GET", "/session"],
      ["GET", "/session/status"],
      ["GET", "/session/ses_missing"],
      ["GET", "/session/ses_missing/children"],
      ["GET", "/session/ses_missing/todo"],
      ["GET", "/session/ses_missing/diff"],
      ["GET", "/session/ses_missing/message"],
      ["GET", "/session/ses_missing/message/msg_missing"],
      ["POST", "/session"],
      ["DELETE", "/session/ses_missing"],
      ["PATCH", "/session/ses_missing"],
      ["POST", "/session/ses_missing/fork"],
      ["POST", "/session/ses_missing/abort"],
      ["POST", "/session/ses_missing/init"],
      ["POST", "/session/ses_missing/share"],
      ["DELETE", "/session/ses_missing/share"],
      ["POST", "/session/ses_missing/summarize"],
      ["POST", "/session/ses_missing/message"],
      ["POST", "/session/ses_missing/prompt_async"],
      ["POST", "/session/ses_missing/command"],
      ["POST", "/session/ses_missing/shell"],
      ["POST", "/session/ses_missing/revert"],
      ["POST", "/session/ses_missing/unrevert"],
      ["POST", "/session/ses_missing/permissions/per_missing"],
      ["DELETE", "/session/ses_missing/message/msg_missing"],
      ["DELETE", "/session/ses_missing/message/msg_missing/part/prt_missing"],
      ["PATCH", "/session/ses_missing/message/msg_missing/part/prt_missing"],
    ] as const

    for (const token of [undefined, "incorrect-control-token"]) {
      for (const [method, path] of sessionRoutes) {
        const response = await app().request(path, {
          method,
          headers: headers(directory.path, token),
          body: method === "GET" ? undefined : "{}",
        })
        expect(response.status).toBe(404)
        expect(await response.text()).toBe("")
      }
    }

    const sessions = await app().request("/session", {
      headers: headers(directory.path, controlToken),
    })
    expect(sessions.status).toBe(200)
    expect(await sessions.json()).toEqual([])
  })

  test("allows daemon-authenticated session lifecycle requests", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    enableArena()
    const sessionID = await createSession(directory.path)
    const privateHeaders = headers(directory.path, controlToken)

    const list = await app().request("/session", { headers: privateHeaders })
    const detail = await app().request(`/session/${sessionID}`, { headers: privateHeaders })
    const update = await app().request(`/session/${sessionID}`, {
      method: "PATCH",
      headers: privateHeaders,
      body: JSON.stringify({ title: "Updated by daemon" }),
    })
    const fork = await app().request(`/session/${sessionID}/fork`, {
      method: "POST",
      headers: privateHeaders,
      body: "{}",
    })

    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([expect.objectContaining({ id: sessionID })])
    expect(detail.status).toBe(200)
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual(expect.objectContaining({ title: "Updated by daemon" }))
    expect(fork.status).toBe(200)
  })

  test("leaves non-Arena OpenCode HTTP behavior unchanged", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const publicHeaders = headers(directory.path)

    expect((await app().request("/doc")).status).toBe(200)
    const created = await app().request("/session", {
      method: "POST",
      headers: publicHeaders,
      body: JSON.stringify({ title: "Ordinary OpenCode" }),
    })
    expect(created.status).toBe(200)
    expect((await app().request("/session", { headers: publicHeaders })).status).toBe(200)
  })
})
