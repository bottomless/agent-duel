import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { defaultPool } from "@agent-duel/arena-service/default-pool"
import { comparisonModel } from "@agent-duel/arena-service/utility-model"
import { createBattleAssignments, resolveAssignments } from "@/arena/assignment-client"
import { createArenaBackend } from "@/arena/backend"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { backend, closeStore, contestantFetch, registry, store } from "@/arena/runtime"
import { tmpdir } from "../fixture/fixture"

type NetworkRequest = {
  readonly url: string
  readonly authorization: string | null
  readonly body: Record<string, unknown> | undefined
}

const originalFetch = globalThis.fetch
const originalHome = process.env.PASEO_HOME

afterEach(async () => {
  mock.restore()
  await closeStore()
  setArenaCredentials(undefined)
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.PASEO_HOME
  else process.env.PASEO_HOME = originalHome
})

/** Stands in for the whole network. Only OpenRouter answers; a control-plane call fails the test. */
function fakeNetwork() {
  const requests: NetworkRequest[] = []
  const execute = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const text = await request.text()
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    })
    if (request.url === "https://openrouter.ai/api/v1/models/user") {
      return Response.json({
        data: defaultPool.map((profile) => ({
          canonical_slug: profile.canonicalSlug,
          context_length: profile.contextWindow,
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools", "tool_choice", "reasoning", "reasoning_effort"],
          reasoning: { supported_efforts: ["high"] },
        })),
      })
    }
    if (request.url === "https://openrouter.ai/api/v1/chat/completions") {
      return Response.json({
        id: "provider-generation",
        model: "provider/model-version",
        provider: "hidden-provider",
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.123 },
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      })
    }
    throw new Error(`Unexpected network request: ${request.url}`)
  }
  globalThis.fetch = Object.assign(execute, { preconnect: originalFetch.preconnect.bind(originalFetch) })
  return requests
}

describe("Arena backend", () => {
  test("BYOK credentials answer assignments and contestant calls in process from the local SQLite store", async () => {
    await using directory = await tmpdir()
    process.env.PASEO_HOME = directory.path
    const network = fakeNetwork()
    const warn = spyOn(console, "warn")
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-user-key",
      controlTokenHash: hashArenaControlToken("local-control-token"),
    })

    const { a, b } = await createBattleAssignments("turn-byok")
    const local = await store()
    const sets = await local.db.collection("arenaAssignmentSets").find({}).toArray()
    expect(sets).toEqual([
      expect.objectContaining({
        userId: "local",
        scopeID: "turn-byok",
        kind: "battle",
        assignments: [
          expect.objectContaining({ assignmentID: a.assignmentID }),
          expect.objectContaining({ assignmentID: b.assignmentID }),
        ],
      }),
    ])

    registry.assign("byok-session-a", {
      runID: "byok-run-a",
      rootSessionID: "byok-session-a",
      scopeID: "turn-byok",
      assignmentID: a.assignmentID,
      telemetry: false,
    })
    const response = await contestantFetch("http://localhost/arena/openrouter/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "byok-session-a",
        "x-arena-request-id": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ model: "contestant", messages: [{ role: "user", content: "fix it" }], stream: false }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("done")
    expect(text).not.toContain("provider/model-version")
    expect(text).not.toContain("hidden-provider")

    const target = backend()
    if (!target) throw new Error("BYOK credentials did not produce an Arena backend")
    const comparison = await target.fetch(`${target.url}/api/arena/comparison`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeID: "turn-byok", messages: [{ role: "user", content: "compare" }], temperature: 0 }),
    })
    expect(comparison.status).toBe(200)

    const resolved = await resolveAssignments("battle", "turn-byok", "select:a")
    expect(resolved.decision).toBe("select:a")
    const names: readonly string[] = defaultPool.map((profile) => profile.displayName)
    expect(resolved.assignments.map((assignment) => names.includes(assignment.model))).toEqual([true, true])
    expect(resolved.assignments[0]?.metrics).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5 }) }),
    ])

    const slugs: readonly string[] = defaultPool.map((profile) => profile.slug)
    expect(network.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/models/user",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ])
    expect(network.every((request) => request.authorization === "Bearer sk-or-v1-user-key")).toBe(true)
    expect(slugs).toContain(String(network[1]?.body?.model))
    expect(network[2]?.body).toMatchObject({ model: comparisonModel.id })

    // A hosted build would have buffered this for upload and warned about it when the store closed.
    await local.saveEvent({
      _id: "byok-event-1",
      turnID: "turn-byok",
      sequence: 1,
      receivedAt: new Date("2026-10-05T00:00:00Z"),
      type: "message.part.updated",
      payload: { text: "stays local" },
      redactionVersion: "arena-privacy-v1",
      normalizationVersion: "arena-events-v1",
      coalesced: false,
      gap: false,
    })
    await closeStore()
    expect(warn.mock.calls.filter(([message]) => String(message).startsWith("[arena-research]"))).toEqual([])
    expect(network).toHaveLength(3)
  })

  test("hosted credentials send the account capability to the control plane", async () => {
    const network = fakeNetwork()
    const hosted = createArenaBackend(
      {
        mode: "hosted",
        token: "test-session",
        controlPlaneUrl: "https://control.test",
        controlTokenHash: hashArenaControlToken("local-control-token"),
      },
      async () => {
        throw new Error("A hosted backend never opens the local database")
      },
    )
    await expect(
      hosted.fetch(`${hosted.url}/api/arena/assignments`, {
        method: "POST",
        headers: { Authorization: "Bearer caller-supplied", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", kind: "battle", scopeID: "turn-hosted" }),
      }),
    ).rejects.toThrow("Unexpected network request: https://control.test/api/arena/assignments")
    expect(network).toEqual([
      {
        url: "https://control.test/api/arena/assignments",
        authorization: "Bearer test-session",
        body: { action: "create", kind: "battle", scopeID: "turn-hosted" },
      },
    ])
  })
})
