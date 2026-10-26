import { afterEach, describe, expect, test } from "bun:test"
import { closeStore, contestantFetch, recoverOnce, setStoreForTest, store } from "@/arena/runtime"
import { setArenaCredentials } from "@/arena/credentials"
import { resolveBuildMetadata } from "@/arena/provenance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await closeStore()
  setStoreForTest(undefined)
  setArenaCredentials(undefined)
})

describe("ArenaRuntime local persistence", () => {
  test("opens and reloads local history and artifact bytes without a control-plane connection", async () => {
    await using directory = await tmpdir()
    const originalHome = process.env.PASEO_HOME
    process.env.PASEO_HOME = directory.path
    setArenaCredentials(undefined)
    try {
      const local = await store()
      const receivedAt = new Date("2026-09-14T00:00:00Z")
      await local.saveEvent({
        _id: "event-1",
        turnID: "turn-1",
        sequence: 1,
        receivedAt,
        type: "message.part.updated",
        payload: { text: "local history" },
        redactionVersion: "arena-privacy-v1",
        normalizationVersion: "arena-events-v1",
        coalesced: false,
        gap: false,
      })
      await local.storeArtifact({
        _id: "transcript-1",
        kind: "transcript",
        mimeType: "application/json",
        encoding: "json",
        compression: "none",
        data: Buffer.from('{"text":"local history"}'),
        createdAt: receivedAt,
      })
      await closeStore()
      const reopened = await store()
      const event = await reopened.events.findOne({ _id: "event-1" })
      expect(event?.receivedAt).toEqual(receivedAt)
      expect(event?.payload).toEqual({ text: "local history" })
      expect((await reopened.artifacts.findOne({ _id: "transcript-1" }))?.data.toString()).toBe(
        '{"text":"local history"}',
      )
    } finally {
      await closeStore()
      if (originalHome === undefined) delete process.env.PASEO_HOME
      else process.env.PASEO_HOME = originalHome
    }
  })

  test("uploads the OpenCode version and separate Agent Duel build metadata through the control plane", async () => {
    await using directory = await tmpdir()
    const originalHome = process.env.PASEO_HOME
    process.env.PASEO_HOME = directory.path
    const received = Promise.withResolvers<{ authorization: string | null; body: Record<string, unknown> }>()
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/api/research") return new Response(null, { status: 404 })
          received.resolve({
            authorization: request.headers.get("authorization"),
            body: (await request.json()) as Record<string, unknown>,
          })
          return new Response(null, { status: 204 })
        },
      })
      setArenaCredentials({
        mode: "hosted",
        researchPartition: "test-research-partition",
        researchAccountID: "test-account",
        token: "arena-runtime-test-token",
        controlPlaneUrl: server.url.toString(),
        controlTokenHash: "0".repeat(64),
      })
      const local = await store()
      const build = await resolveBuildMetadata({ OPENCODE_ARENA_BUILD_SHA: "abcdef1234567" })
      const createdAt = new Date("2026-09-14T00:00:00Z")
      const chat = {
        _id: "chat-upload-1",
        repository: { projectID: "project", root: directory.path },
        initialCanonicalSHA: "base",
        currentCanonicalSHA: "base",
        canonicalSessionID: "canonical",
        canonicalTranscriptVersion: 1,
        canonicalTranscriptHash: "hash",
        turnCount: 0,
        status: "ready" as const,
        ...build,
        configuration: {
          modelPool: "pool",
          agent: "agent",
          plugins: "plugins",
          mcp: "mcp",
          skills: "skills",
          tools: "tools",
          system: "system",
        },
        utilityPromptVersion: "utility",
        createdAt,
        updatedAt: createdAt,
      }
      await local.createChat(chat)
      const upload = await Promise.race([
        received.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Research upload timed out")), 3_000)),
      ])
      expect(upload.authorization).toBe("Bearer arena-runtime-test-token")
      expect(upload.body.version).toBe(1)
      expect(upload.body.sourceID).toEqual(expect.any(String))
      expect(upload.body.records).toEqual([
        {
          collection: "chats",
          id: chat._id,
          revision: 1,
          document: { ...chat, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString() },
        },
      ])
    } finally {
      await closeStore()
      setArenaCredentials(undefined)
      server?.stop(true)
      if (originalHome === undefined) delete process.env.PASEO_HOME
      else process.env.PASEO_HOME = originalHome
    }
  })

  test("does not use a legacy environment key without in-memory Arena credentials", async () => {
    const originalKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = "legacy-key-must-not-be-used"
    setArenaCredentials(undefined)
    try {
      const response = await contestantFetch("http://127.0.0.1:1/api/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: { message: "Arena OpenRouter credentials are unavailable", type: "arena_configuration_error" },
      })
    } finally {
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = originalKey
    }
  })
})

describe("ArenaRuntime recovery", () => {
  test("runs startup recovery once across concurrent Arena service layers", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = recoverOnce(async () => {
      calls += 1
      await gate
    })
    const second = recoverOnce(async () => {
      calls += 1
    })

    expect(first).toBe(second)
    expect(calls).toBe(1)
    release()
    await Promise.all([first, second])
    await recoverOnce(async () => {
      calls += 1
    })
    expect(calls).toBe(1)
  })

  test("allows a failed recovery to be retried", async () => {
    await expect(recoverOnce(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed")
    let retried = false
    await recoverOnce(async () => {
      retried = true
    })
    expect(retried).toBe(true)
  })
})
