import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ArenaRuntime } from "@/arena/runtime"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { GlobalBus } from "@/bus/global"
import type { ChatDocument } from "@/arena/records"
import { Server } from "@/server/server"

const controlToken = "v2-native-smoke"
const headers = () => ({
  "content-type": "application/json",
  "x-paseo-control-token": controlToken,
})

function activeBattleChat(canonicalSessionID: string, root: string): ChatDocument {
  const now = new Date("2026-10-26T00:00:00.000Z")
  return {
    _id: "chat-canonical-environment",
    repository: { projectID: "project", root, branch: "main" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID,
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "battle_active",
    agentDuelCommit: "commit",
    agentDuelBuildNumber: 0,
    opencodeVersion: "2.0.32",
    agentDuelVersion: "test",
    configuration: {
      modelPool: "hash",
      agent: "hash",
      plugins: "hash",
      mcp: "hash",
      skills: "hash",
      tools: "hash",
      system: "hash",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
}

describe("Arena OpenCode v2 native boundary", () => {
  let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
  let controlPlane: ReturnType<typeof Bun.serve> | undefined
  let home: string | undefined
  const previousHome = process.env.PASEO_HOME
  const previousDatabase = process.env.OPENCODE_DB

  afterEach(async () => {
    if (listener) await listener.stop(true)
    listener = undefined
    controlPlane?.stop(true)
    controlPlane = undefined
    await ArenaRuntime.closeStore()
    setArenaCredentials(undefined)
    if (previousHome === undefined) delete process.env.PASEO_HOME
    else process.env.PASEO_HOME = previousHome
    if (previousDatabase === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previousDatabase
    if (home) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  test("serves authenticated v2 info, empty catalogs, and normal prompt admission", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-server-"))
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    const assignments: Array<{ action?: string; modelSize?: string; scopeID?: string }> = []
    controlPlane = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/api/arena/assignments") {
          const input = (await request.json()) as { action?: string; modelSize?: string; scopeID?: string }
          assignments.push(input)
          if (input.action === "create") {
            return Response.json({ assignments: [{ assignmentID: `native-${input.modelSize ?? "medium"}` }] })
          }
          return Response.json({ assignments: [{ assignmentID: "native-smoke-assignment", model: "test/model" }] })
        }
        if (pathname === "/api/openrouter/api/v1/chat/completions") {
          const body = (await request.json()) as {
            model?: string
            messages?: Array<{ role?: string; content?: unknown }>
          }
          assignments.push({ action: "completion", scopeID: body.model })
          const encoder = new TextEncoder()
          const multipart = JSON.stringify(body.messages ?? []).includes("native multipart bridge")
          const hasToolResult = (body.messages ?? []).some((message) => message.role === "tool")
          const chunks =
            multipart && !hasToolResult
              ? [
                  {
                    id: "chatcmpl-native-multipart-1",
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          reasoning: "provider-secret-reasoning",
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-native-multipart-1",
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: "before ",
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-native-multipart-1",
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: "😀",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-native-bridge",
                              type: "function",
                              function: {
                                name: "edit",
                                arguments: JSON.stringify({
                                  path: "bridge-marker.txt",
                                  oldString: "before",
                                  newString: "bridge-tool-output",
                                }),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-native-multipart-1",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
                  },
                ]
              : [
                  {
                    id: "chatcmpl-native-smoke",
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          content: multipart ? "native completion after tool" : "native completion",
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-native-smoke",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
                  },
                ]
          const encoded = chunks.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          const streamBody = multipart
            ? new ReadableStream<Uint8Array>({
                async start(controller) {
                  for (const chunk of encoded) {
                    controller.enqueue(chunk)
                    await Bun.sleep(5)
                  }
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  controller.close()
                },
              })
            : encoder.encode(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`)
          return new Response(streamBody, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    setArenaCredentials({
      mode: "hosted",
      token: "test-token",
      controlPlaneUrl: `http://127.0.0.1:${controlPlane.port}`,
      controlTokenHash: hashArenaControlToken(controlToken),
    })
    listener = await Server.listen({
      hostname: "127.0.0.1",
      port: 0,
      fs: { filewatcher: false },
    })

    const get = (route: string, init?: RequestInit) => fetch(new URL(route, listener!.url), init)
    expect((await get("/global/health")).status).toBe(200)
    expect((await get("/api/info")).status).toBe(404)

    const info = await get("/api/info", { headers: { "x-paseo-control-token": controlToken } })
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ id: "contestant", providerID: "arena" })

    for (const route of ["/api/model", "/api/provider"]) {
      const response = await get(route, { headers: { "x-paseo-control-token": controlToken } })
      expect(response.status).toBe(200)
      expect((await response.json()).data).toEqual([])
    }

    const directory = await mkdtemp(path.join(home, "workspace-"))
    await Bun.write(path.join(directory, "bridge-marker.txt"), "before")
    const bridged: Array<{ type?: string; properties?: Record<string, unknown> }> = []
    const onEvent = (event: { payload: Record<string, unknown> }) => {
      const payload = event.payload
      bridged.push({
        type: typeof payload.type === "string" ? payload.type : undefined,
        properties:
          payload.properties && typeof payload.properties === "object"
            ? (payload.properties as Record<string, unknown>)
            : undefined,
      })
    }
    GlobalBus.on("event", onEvent)
    const created = await get("/api/session", {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({
        location: { directory },
        model: { providerID: "arena", id: "contestant" },
      }),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()).data as { id: string; model?: { id?: string; providerID?: string } }

    const prompt = await get(`/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ text: "native multipart bridge", resume: true }),
    })
    expect(prompt.status).toBe(200)
    const admitted = (await prompt.json()).data as { id: string }
    expect(admitted.id).toStartWith("msg_")
    let afterData: {
      model?: { id?: string; providerID?: string }
      outcome?: string
      time?: { idle?: number }
    } = {}
    for (let attempt = 0; attempt < 80; attempt++) {
      const after = await get(`/api/session/${session.id}`, {
        headers: { "x-paseo-control-token": controlToken, "x-opencode-directory": directory },
      })
      expect(after.status).toBe(200)
      afterData = (await after.json()).data as typeof afterData
      if (afterData.outcome === "succeeded" && afterData.time?.idle !== undefined) break
      await Bun.sleep(100)
    }
    expect(afterData.model).toMatchObject({ id: "contestant", providerID: "arena" })
    expect(afterData.outcome).toBe("succeeded")
    expect(afterData.time?.idle).toBeNumber()
    const exported = await get(`/api/experimental/session/${session.id}/export`, {
      headers: { "x-paseo-control-token": controlToken, "x-opencode-directory": directory },
    })
    expect(exported.status).toBe(200)
    const history = (await exported.json()).data as {
      messages?: readonly { id: string; type: string; content?: readonly { type: string }[] }[]
    }
    expect(history.messages?.some((message) => JSON.stringify(message).includes("native completion after tool"))).toBe(
      true,
    )
    expect(JSON.stringify(history)).not.toContain("provider-secret-reasoning")
    await Bun.sleep(100)
    GlobalBus.off("event", onEvent)
    const parts = bridged
      .filter((event) => event.type === "message.part.updated")
      .map((event) => event.properties?.part)
      .filter((part): part is Record<string, unknown> => part !== undefined && typeof part === "object")
    expect(parts.length).toBeGreaterThan(0)
    const idsByType = new Map<string, Set<unknown>>()
    for (const part of parts) {
      const ids = idsByType.get(String(part.type)) ?? new Set<unknown>()
      ids.add(part.id)
      idsByType.set(String(part.type), ids)
    }
    expect([...idsByType.keys()].sort()).toEqual(["reasoning", "text", "tool"])
    const idsByContent = new Map<string, Set<unknown>>()
    for (const part of parts) {
      const contentKey = `${String(part.type)}:${part.type === "tool" ? String(part.callID) : String(part.text)}`
      const ids = idsByContent.get(contentKey) ?? new Set<unknown>()
      ids.add(part.id)
      idsByContent.set(contentKey, ids)
    }
    expect([...idsByContent.values()].every((ids) => ids.size === 1)).toBe(true)
    const canonicalParts = new Map(
      history.messages?.flatMap((message) =>
        message.type === "assistant"
          ? (message.content ?? []).map((part, index) => [`prt_${message.id.slice(4)}_${index}`, part.type] as const)
          : [],
      ),
    )
    for (const part of parts) expect(canonicalParts.get(String(part.id))).toBe(part.type)
    expect(new Set(parts.map((part) => part.id)).size).toBe(canonicalParts.size)
    expect(canonicalParts.size).toBe(4)
    expect(new Set(parts.filter((part) => part.type === "text").map((part) => part.id)).size).toBe(2)
    expect(parts.some((part) => part.type === "text" && part.text === "before 😀")).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "native completion after tool")).toBe(true)
    const deltas = bridged
      .filter((event) => event.type === "message.part.delta")
      .map((event) => event.properties)
      .filter((properties): properties is Record<string, unknown> => properties !== undefined)
    expect(deltas.some((delta) => delta.delta === "before 😀" && delta.offset === 0)).toBe(true)
    const tool = parts.findLast(
      (part) => part.type === "tool" && (part.state as Record<string, unknown> | undefined)?.status === "completed",
    )
    expect(tool?.state).toMatchObject({ status: "completed", output: "Edited bridge-marker.txt (1 replacement)" })
    const store = await ArenaRuntime.store()
    let rating = await store.singleAgentRating(session.id, admitted.id)
    for (let attempt = 0; attempt < 40 && !rating?.completedAt; attempt++) {
      await Bun.sleep(100)
      rating = await store.singleAgentRating(session.id, admitted.id)
    }
    expect(rating).toMatchObject({ modelSize: "frontier", messageID: admitted.id })
    expect(rating?.completedAt).toBeDefined()
    expect(assignments.some((item) => item.action === "create" && item.modelSize === "frontier")).toBe(true)
  })

  test("blocks an unresolved contestant mutation while allowing session reads", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-guard-"))
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "test-key",
      controlTokenHash: hashArenaControlToken(controlToken),
    })
    listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fs: { filewatcher: false } })
    const directory = await mkdtemp(path.join(home, "workspace-"))
    const created = await fetch(new URL("/api/session", listener.url), {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ location: { directory } }),
    })
    const sessionID = ((await created.json()).data as { id: string }).id
    ArenaRuntime.registry.assign(sessionID, {
      runID: "run-unresolved",
      rootSessionID: sessionID,
      scopeID: "run-unresolved",
      assignmentID: "assignment-unresolved",
      telemetry: true,
    })
    const read = await fetch(new URL(`/api/session/${sessionID}`, listener.url), {
      headers: { "x-paseo-control-token": controlToken, "x-opencode-directory": directory },
    })
    expect(read.status).toBe(200)
    const mutation = await fetch(new URL(`/api/session/${sessionID}/model`, listener.url), {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ providerID: "arena", modelID: "medium" }),
    })
    expect(mutation.status).toBe(409)
    const environment = await fetch(new URL(`/api/session/${sessionID}/environment`, listener.url), {
      method: "PUT",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ variables: { ARENA_SYNC: "contestant" } }),
    })
    expect(environment.status).toBe(409)
  })

  test("allows canonical environment synchronization during an active battle while guarding model changes", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-canonical-environment-"))
    process.env.PASEO_HOME = home
    process.env.OPENCODE_DB = path.join(home, "opencode-local.db")
    process.env.OPENCODE_ARENA = "1"
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "test-key",
      controlTokenHash: hashArenaControlToken(controlToken),
    })
    listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fs: { filewatcher: false } })

    const directory = await mkdtemp(path.join(home, "workspace-"))
    const created = await fetch(new URL("/api/session", listener.url), {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ location: { directory }, model: { providerID: "arena", id: "contestant" } }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()).data as { id: string }).id

    const store = await ArenaRuntime.store()
    await store.createChat(activeBattleChat(sessionID, directory))

    const environment = await fetch(new URL(`/api/session/${sessionID}/environment`, listener.url), {
      method: "PUT",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ variables: { ARENA_SYNC: "canonical" } }),
    })
    const environmentResult = { status: environment.status, body: await environment.text() }

    const mutation = await fetch(new URL(`/api/session/${sessionID}/model`, listener.url), {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ providerID: "arena", modelID: "medium" }),
    })
    const mutationResult = { status: mutation.status, body: await mutation.text() }

    expect(mutationResult.status).toBe(409)
    expect(environmentResult).toEqual({ status: 204, body: "" })
  })

  test("retains native sessions across a server restart using a persistent database", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-persistent-"))
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    const database = path.join(home, "opencode-local.db")
    process.env.OPENCODE_DB = database
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "test-key",
      controlTokenHash: hashArenaControlToken(controlToken),
    })
    listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fs: { filewatcher: false } })
    const directory = await mkdtemp(path.join(home, "workspace-"))
    const created = await fetch(new URL("/api/session", listener.url), {
      method: "POST",
      headers: { ...headers(), "x-opencode-directory": directory },
      body: JSON.stringify({ location: { directory } }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()).data as { id: string }).id
    expect(existsSync(database)).toBe(true)
    await listener.stop(true)
    listener = undefined

    listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fs: { filewatcher: false } })
    const restored = await fetch(new URL(`/api/session/${sessionID}`, listener.url), {
      headers: { "x-paseo-control-token": controlToken, "x-opencode-directory": directory },
    })
    expect(restored.status).toBe(200)
    expect((await restored.json()).data.id).toBe(sessionID)
    const history = await fetch(new URL(`/api/experimental/session/${sessionID}/export`, listener.url), {
      headers: { "x-paseo-control-token": controlToken, "x-opencode-directory": directory },
    })
    expect(history.status).toBe(200)
    expect(Array.isArray(((await history.json()).data as { messages?: unknown[] }).messages)).toBe(true)
  })

  test(
    "keeps the authenticated v2 event stream open through its first timed heartbeat",
    async () => {
      home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-sse-"))
      process.env.PASEO_HOME = home
      process.env.OPENCODE_DB = path.join(home, "opencode-local.db")
      process.env.OPENCODE_ARENA = "1"
      setArenaCredentials({
        mode: "byok",
        openRouterApiKey: "loopback-placeholder",
        controlTokenHash: hashArenaControlToken(controlToken),
      })
      listener = await Server.listen({ hostname: "127.0.0.1", port: 0, fs: { filewatcher: false } })

      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), 20_000)
      const response = await fetch(new URL("/api/event", listener.url), {
        signal: abort.signal,
        headers: {
          accept: "text/event-stream",
          "x-paseo-control-token": controlToken,
        },
      })
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()

      let connected = false
      let streamClosed = false
      const heartbeatAtMs: number[] = []
      let streamError: string | undefined
      const decoder = new TextDecoder()
      const startedAt = Date.now()
      let received = ""
      let heartbeatCount = 0
      try {
        while (!heartbeatAtMs.some((atMs) => atMs >= 10_000)) {
          const result = await reader!.read()
          if (result.done) {
            streamClosed = true
            break
          }
          received += decoder.decode(result.value, { stream: true })
          connected ||= received.includes("server.connected")
          const nextHeartbeatCount = received.split(": heartbeat\n\n").length - 1
          while (heartbeatCount < nextHeartbeatCount) {
            heartbeatCount++
            heartbeatAtMs.push(Date.now() - startedAt)
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(timeout)
        abort.abort()
        await reader!.cancel().catch(() => undefined)
      }

      expect(connected).toBe(true)
      expect(streamClosed).toBe(false)
      expect(streamError).toBeUndefined()
      expect(heartbeatAtMs.some((atMs) => atMs >= 10_000)).toBe(true)
    },
    { timeout: 25_000 },
  )
})
