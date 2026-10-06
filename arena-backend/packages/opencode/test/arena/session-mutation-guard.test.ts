import { afterEach, describe, expect, test } from "bun:test"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import type { Store } from "@/arena/mongo"
import {
  isBattleActiveCanonicalSession,
  isUnresolvedContestantSession,
  registry,
  setStoreForTest,
} from "@/arena/runtime"
import { Server } from "@/server/server"
import { SessionID } from "@/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const controlToken = "private-control-token"

function enableArena() {
  setArenaCredentials({
    mode: "hosted",
    token: "private-runtime-token",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken(controlToken),
  })
  process.env.OPENCODE_ARENA = "1"
}

function app() {
  return Server.Default().app
}

async function createSession(headers: Record<string, string>, input: { title: string; parentID?: SessionID }) {
  const response = await app().request("/session", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  const value = await response.json()
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Session response did not contain an ID")
  }
  return SessionID.make(value.id)
}

function store(input: { running: { root: SessionID; descendant: SessionID }; complete: { root: SessionID } }) {
  const running = {
    _id: "run-running",
    turnID: "turn-running",
    rootSessionID: input.running.root,
    descendantSessionIDs: [input.running.descendant],
  }
  const complete = {
    _id: "run-complete",
    turnID: "turn-complete",
    rootSessionID: input.complete.root,
    descendantSessionIDs: [],
  }
  const runs = [running, complete]
  return {
    chatForSession: async () => undefined,
    runs: {
      findOne: async (query: unknown) => {
        const value = JSON.stringify(query)
        return runs.find(
          (run) => value.includes(run.rootSessionID) || run.descendantSessionIDs.some((id) => value.includes(id)),
        )
      },
    },
    run: async (runID: string) => runs.find((run) => run._id === runID),
    turn: async (turnID: string) => {
      if (turnID === running.turnID) return { state: "running" }
      if (turnID === complete.turnID) return { state: "complete" }
      return null
    },
  } as unknown as Store
}

async function prompt(headers: Record<string, string>, sessionID: SessionID) {
  return app().request(`/session/${sessionID}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue" }],
    }),
  })
}

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setArenaCredentials(undefined)
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("Arena contestant session mutation guard", () => {
  test("blocks unresolved contestant roots and descendants without locking canonical or resolved sessions", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
      "x-paseo-control-token": controlToken,
    }
    const root = await createSession(headers, { title: "contestant root" })
    const descendant = await createSession(headers, { title: "contestant descendant", parentID: root })
    const canonical = await createSession(headers, { title: "canonical" })
    const unrelatedV2 = SessionID.descending()
    const resolved = await createSession(headers, { title: "resolved contestant" })

    setStoreForTest(store({ running: { root, descendant }, complete: { root: resolved } }))
    enableArena()
    expect(await isUnresolvedContestantSession(canonical)).toBe(false)
    expect(await isBattleActiveCanonicalSession(canonical)).toBe(false)
    expect(await isUnresolvedContestantSession(resolved)).toBe(false)

    const read = await app().request(`/session/${root}`, { headers })
    const remove = await app().request(`/session/${root}`, { method: "DELETE", headers })
    const update = await app().request(`/session/${root}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "mutated" }),
    })
    const fork = await app().request(`/session/${descendant}/fork`, { method: "POST", headers })
    const createChild = await app().request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "forbidden child", parentID: root }),
    })
    const rootPrompt = await prompt(headers, root)
    const descendantPrompt = await prompt(headers, descendant)
    const rootV2Prompt = await app().request(`/api/session/${root}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: { text: "bypass" }, resume: false }),
    })
    const rootV2Interrupt = await app().request(`/api/session/${root}/interrupt`, { method: "POST", headers })
    process.env.OPENCODE_ARENA = "0"
    const canonicalPrompt = await prompt(headers, canonical)
    const unrelatedV2Interrupt = await app().request(`/api/session/${unrelatedV2}/interrupt`, {
      method: "POST",
      headers,
    })
    const resolvedPrompt = await prompt(headers, resolved)

    expect(read.status).toBe(200)
    expect(remove.status).toBe(400)
    expect(update.status).toBe(400)
    expect(fork.status).toBe(400)
    expect(createChild.status).toBe(400)
    expect(rootPrompt.status).toBe(400)
    expect(descendantPrompt.status).toBe(400)
    expect(rootV2Prompt.status).toBe(404)
    expect(rootV2Interrupt.status).toBe(404)
    expect(canonicalPrompt.status).toBe(200)
    expect(unrelatedV2Interrupt.status).toBe(404)
    expect(resolvedPrompt.status).toBe(200)

    expect((await app().request(`/session/${root}`, { headers })).status).toBe(200)
    expect(await (await app().request(`/session/${root}/message`, { headers })).json()).toEqual([])
    expect(await (await app().request(`/session/${descendant}/message`, { headers })).json()).toEqual([])
    expect(await (await app().request(`/session/${canonical}/message`, { headers })).json()).toHaveLength(1)
    expect(await (await app().request(`/session/${resolved}/message`, { headers })).json()).toHaveLength(1)
  })

  test("fails closed for a newly assigned descendant before MongoDB records it", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
      "x-paseo-control-token": controlToken,
    }
    const descendant = await createSession(headers, { title: "fresh descendant" })

    setStoreForTest({
      chatForSession: async () => undefined,
      runs: { findOne: async () => null },
      run: async () => null,
    } as unknown as Store)
    registry.assign(descendant, {
      runID: "run-not-yet-persisted",
      rootSessionID: "root",
      scopeID: "turn-a",
      assignmentID: "assignment-a",
      telemetry: true,
    })
    enableArena()

    expect((await prompt(headers, descendant)).status).toBe(400)
    expect(await (await app().request(`/session/${descendant}/message`, { headers })).json()).toEqual([])
  })

  test("blocks canonical session prompts while a battle is active but allows forking", async () => {
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
      "x-paseo-control-token": controlToken,
    }
    const canonical = await createSession(headers, { title: "battle canonical" })
    setStoreForTest({
      chatForSession: async () => ({ status: "battle_active", canonicalSessionID: canonical }),
      runs: { findOne: async () => null },
    } as unknown as Store)
    enableArena()

    const arbitraryModel = await app().request(`/session/${canonical}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: "build",
        noReply: true,
        model: { providerID: "arbitrary", modelID: "arbitrary-model" },
        parts: [{ type: "text", text: "must not reach model resolution" }],
      }),
    })
    const fork = await app().request(`/session/${canonical}/fork`, {
      method: "POST",
      headers,
    })
    expect(arbitraryModel.status).toBe(400)
    expect(fork.status).toBe(200)
    expect(await (await app().request(`/session/${canonical}/message`, { headers })).json()).toEqual([])
  })
})
