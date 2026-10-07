import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import type { Store } from "@/arena/mongo"
import { ArenaAttachments } from "@/arena/attachments"
import { ArenaPrivacy } from "@/arena/privacy"
import { setStoreForTest } from "@/arena/runtime"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"

const hiddenAlias = "arena-01"
const hiddenSlug = "anthropic/claude-opus-5-20260723"
const hiddenProvider = "secret-provider"
const controlToken = "private-control-token"

function app() {
  return Server.Default().app
}

function enableArenaControl() {
  process.env.OPENCODE_ARENA = "1"
  setArenaCredentials({
    mode: "hosted",
    token: "private-runtime-token",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken(controlToken),
  })
}

function contestantMessage(sessionID = SessionID.descending()): SessionV1.WithParts {
  const userID = MessageID.ascending()
  const assistantID = MessageID.ascending()
  return {
    info: {
      id: assistantID,
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: userID,
      modelID: ModelV2.ID.make(hiddenAlias),
      providerID: ProviderV2.ID.make(hiddenProvider),
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 9.5,
      tokens: { total: 42, input: 20, output: 10, reasoning: 12, cache: { read: 3, write: 4 } },
      error: {
        name: "APIError",
        data: {
          message: `${hiddenProvider} rejected ${hiddenAlias}`,
          statusCode: 503,
          isRetryable: true,
          responseHeaders: { "x-model": hiddenSlug },
          responseBody: `raw upstream body from ${hiddenSlug}`,
          metadata: { provider: hiddenProvider },
        },
      },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: assistantID,
        type: "text",
        text: "User-authored model and provider fields remain ordinary content.",
        metadata: { model: hiddenSlug, provider: hiddenProvider },
      },
      {
        id: PartID.ascending(),
        sessionID,
        messageID: assistantID,
        type: "reasoning",
        text: "reasoning",
        time: { start: 1, end: 2 },
        metadata: { model: hiddenSlug, provider: hiddenProvider, format: "xai-responses-v1" },
      },
      {
        id: PartID.ascending(),
        sessionID,
        messageID: assistantID,
        type: "retry",
        attempt: 1,
        time: { created: 1 },
        error: {
          name: "APIError",
          data: {
            message: `${hiddenProvider} unavailable`,
            isRetryable: true,
            responseBody: hiddenSlug,
          },
        },
      },
      {
        id: PartID.ascending(),
        sessionID,
        messageID: assistantID,
        type: "step-finish",
        reason: "stop",
        cost: 9.5,
        tokens: { total: 42, input: 20, output: 10, reasoning: 12, cache: { read: 3, write: 4 } },
      },
      {
        id: PartID.ascending(),
        sessionID,
        messageID: assistantID,
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Inspect the repository" },
          output: "Done",
          title: "Inspect",
          metadata: {
            sessionId: "ses_child",
            model: hiddenSlug,
            nested: { provider: hiddenProvider },
          },
          time: { start: 1, end: 2 },
        },
        metadata: { provider: hiddenProvider, providerExecuted: true },
      },
    ],
  }
}

function sse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("SSE response has no body")
  const decoder = new TextDecoder()
  let pending = ""
  return {
    reader,
    async next() {
      while (true) {
        const match = /\r?\n\r?\n/.exec(pending)
        if (match?.index !== undefined) {
          const block = pending.slice(0, match.index)
          pending = pending.slice(match.index + match[0].length)
          const line = block.split(/\r?\n/).find((item) => item.startsWith("data: "))
          if (line) return JSON.parse(line.slice("data: ".length)) as unknown
          continue
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error("SSE stream closed before an event arrived")
        pending += decoder.decode(chunk.value, { stream: true })
      }
    },
  }
}

afterEach(async () => {
  setStoreForTest(undefined)
  setArenaCredentials(undefined)
  delete process.env.OPENCODE_ARENA
  await disposeAllInstances()
  await resetDatabase()
})

describe("ArenaPrivacy", () => {
  test("coordinates queued-message discard reservations and prompt claims atomically", () => {
    const claimedFirst = "privacy-claims-first"
    const discardedFirst = "privacy-discard-first"
    const conflict = "conflict"
    const available = "available"
    const released = "released"

    try {
      expect(ArenaPrivacy.claimMessages(claimedFirst, [conflict, available])).toBe(true)
      expect(ArenaPrivacy.reserveDiscard(claimedFirst, [conflict])).toBe(false)
      expect(ArenaPrivacy.reserveDiscard(claimedFirst, [released, conflict])).toBe(false)
      expect(ArenaPrivacy.isMessageDiscarded(claimedFirst, released)).toBe(false)
      expect(ArenaPrivacy.isMessageDiscarded(claimedFirst, conflict)).toBe(false)

      expect(ArenaPrivacy.reserveDiscard(discardedFirst, [conflict, available])).toBe(true)
      expect(ArenaPrivacy.claimMessages(discardedFirst, [conflict])).toBe(false)
      expect(ArenaPrivacy.claimMessages(discardedFirst, [available])).toBe(false)

      const discardConflict = "privacy-discard-conflict"
      expect(ArenaPrivacy.claimMessages(discardConflict, [conflict])).toBe(true)
      expect(ArenaPrivacy.reserveDiscard(discardConflict, [available, conflict])).toBe(false)
      expect(ArenaPrivacy.isMessageDiscarded(discardConflict, available)).toBe(false)
      expect(ArenaPrivacy.reserveDiscard(discardConflict, [available])).toBe(true)
      ArenaPrivacy.releaseDiscard(discardConflict, [available])
      expect(ArenaPrivacy.reserveDiscard(discardConflict, [released])).toBe(true)
      ArenaPrivacy.releaseDiscard(discardConflict, [released])
      expect(ArenaPrivacy.reserveDiscard(discardConflict, [released])).toBe(true)
      ArenaPrivacy.releaseDiscard(discardConflict, [released])

      const claimRelease = "privacy-claim-release"
      expect(ArenaPrivacy.reserveDiscard(claimRelease, [released])).toBe(true)
      ArenaPrivacy.releaseDiscard(claimRelease, [released])
      expect(ArenaPrivacy.claimMessages(claimRelease, [released])).toBe(true)
      ArenaPrivacy.releaseClaims(claimRelease, [released])
      expect(ArenaPrivacy.claimMessages(claimRelease, [released])).toBe(true)
      ArenaPrivacy.releaseClaims(claimRelease, [released])

      expect(ArenaPrivacy.reserveDiscard(claimRelease, [released])).toBe(true)
      expect(ArenaPrivacy.claimMessages(claimRelease, [available])).toBe(true)
      ArenaPrivacy.forgetSession(claimRelease)
      expect(ArenaPrivacy.reserveDiscard(claimRelease, [released])).toBe(true)
      expect(ArenaPrivacy.claimMessages(claimRelease, [available])).toBe(true)
    } finally {
      ArenaPrivacy.forgetSession(claimedFirst)
      ArenaPrivacy.forgetSession(discardedFirst)
      ArenaPrivacy.forgetSession("privacy-discard-conflict")
      ArenaPrivacy.forgetSession("privacy-claim-release")
    }
  })

  test("leaves non-Arena values and mutation behavior unchanged", () => {
    delete process.env.OPENCODE_ARENA
    const config = { model: `${hiddenProvider}/${hiddenAlias}`, provider: { [hiddenProvider]: {} } }
    const message = contestantMessage()
    const event = { type: "message.updated", properties: { info: message.info } }

    expect(ArenaPrivacy.config(config)).toBe(config)
    expect(ArenaPrivacy.changesModelConfiguration(config)).toBe(false)
    expect(ArenaPrivacy.message(message)).toBe(message)
    expect(ArenaPrivacy.event(event)).toBe(event)
  })

  test("removes model identity, provider metadata, usage, and raw upstream errors", () => {
    process.env.OPENCODE_ARENA = "1"
    const source = contestantMessage()
    const sanitized = ArenaPrivacy.message(source)
    const json = JSON.stringify(sanitized)

    expect(sanitized).not.toBe(source)
    expect(sanitized.info).toMatchObject({ providerID: "arena", modelID: "contestant", cost: 0 })
    expect(sanitized.parts[0]).toMatchObject({ text: source.parts[0]?.type === "text" ? source.parts[0].text : "" })
    expect(json).not.toContain(hiddenAlias)
    expect(json).not.toContain(hiddenSlug)
    expect(json).not.toContain(hiddenProvider)
    expect(json).not.toContain("raw upstream body")
    expect(json).not.toContain("responseHeaders")
    expect(json).toContain("Arena contestant request failed")
    expect(json).toContain("User-authored model and provider fields remain ordinary content.")
    const tool = sanitized.parts.find((item) => item.type === "tool")
    expect(tool?.type === "tool" && "metadata" in tool.state ? tool.state.metadata : undefined).toEqual({
      sessionId: "ses_child",
      nested: {},
    })
  })

  test("keeps a battle attachment's label on a text part and drops every other metadata key", () => {
    process.env.OPENCODE_ARENA = "1"
    const source = contestantMessage()
    const text = source.parts[0]
    if (text?.type !== "text") throw new Error("fixture's first part is text")
    const attachment = {
      ...text,
      metadata: { ...text.metadata, [ArenaAttachments.METADATA_KEY]: { label: "Review comment" } },
    }

    const sanitized = ArenaPrivacy.message({ ...source, parts: [attachment, ...source.parts.slice(1)] })

    expect(sanitized.parts[0]?.type === "text" ? sanitized.parts[0].metadata : undefined).toEqual({
      [ArenaAttachments.METADATA_KEY]: { label: "Review comment" },
    })
  })

  test("hides billing details and the upstream body in payment failures", () => {
    process.env.OPENCODE_ARENA = "1"
    const source = contestantMessage()
    if (source.info.role !== "assistant") throw new Error("expected assistant")
    source.info.error = {
      name: "APIError",
      data: {
        message: hiddenProvider,
        statusCode: 402,
        isRetryable: false,
        responseBody: JSON.stringify({ error: { code: "arena_credit_limit", provider: hiddenProvider } }),
      },
    }
    const sanitized = JSON.stringify(ArenaPrivacy.message(source))
    expect(sanitized).toContain("The agent could not complete this run.")
    expect(sanitized).not.toMatch(/credit|spending|payment|budget/i)
    expect(sanitized).not.toContain(hiddenProvider)
    expect(sanitized).not.toContain("responseBody")
  })

  test("rewrites upstream tool call IDs into one contestant-agnostic format", () => {
    process.env.OPENCODE_ARENA = "1"
    // Real formats observed per upstream: Alibaba/Z.AI mint `call_<24 hex>`, xAI mints
    // `call-<uuid>-<counter>`, vLLM hosts mint `chatcmpl-tool-<16 hex>`. Any difference
    // between the two sides of a battle identifies the contestant, so all three must
    // collapse onto the same shape.
    const upstream = [
      "call_4078e44cd6914fa588d196b1",
      "call-70293612-c1d2-4a95-a9c5-1fb870da15df-68",
      "chatcmpl-tool-ab9145b12e6c558f",
    ]
    const sanitized = upstream.map((callID) =>
      ArenaPrivacy.part({
        id: PartID.ascending(),
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        type: "tool",
        callID,
        tool: "read",
        state: { status: "pending" },
      }),
    )
    const ids = sanitized.map((item) => (item.type === "tool" ? item.callID : ""))

    for (const id of ids) expect(id).toMatch(/^call_arena_[0-9a-f]{32}$/)
    for (const id of upstream) expect(JSON.stringify(sanitized)).not.toContain(id)
    // The xAI counter discloses how many tool calls happened earlier in the hidden session.
    expect(JSON.stringify(sanitized)).not.toContain("-68")
    expect(new Set(ids).size).toBe(upstream.length)
  })

  test("maps a tool call ID to the same value everywhere it is published", () => {
    process.env.OPENCODE_ARENA = "1"
    const callID = "call-70293612-c1d2-4a95-a9c5-1fb870da15df-68"
    const sessionID = SessionID.descending()
    const toolPart = ArenaPrivacy.part({
      id: PartID.ascending(),
      sessionID,
      messageID: MessageID.ascending(),
      type: "tool",
      callID,
      tool: "read",
      state: { status: "pending" },
    })
    const stable = ArenaPrivacy.part({
      id: PartID.ascending(),
      sessionID,
      messageID: MessageID.ascending(),
      type: "tool",
      callID,
      tool: "read",
      state: { status: "pending" },
    })
    // `session.next.tool.*` carries callID outside the Part schema; the UI correlates the
    // two, so both paths have to agree on the mapping.
    const event = ArenaPrivacy.event({
      type: "session.next.tool.called",
      properties: { sessionID, callID, tool: "read" },
    }) as { properties: { callID: string } }
    const synthetic = toolPart.type === "tool" ? toolPart.callID : ""

    expect(stable.type === "tool" ? stable.callID : "").toBe(synthetic)
    expect(event.properties.callID).toBe(synthetic)
    expect(event.properties.callID).not.toBe(callID)
    // Redaction runs again on replay of already-stored events; it must not re-hash.
    expect(
      ArenaPrivacy.event({ type: "session.next.tool.called", properties: { sessionID, callID: synthetic } }),
    ).toMatchObject({ properties: { callID: synthetic } })
  })

  test("sanitizes V1, V2, and durable replay event envelopes", () => {
    process.env.OPENCODE_ARENA = "1"
    const message = contestantMessage()
    const events = [
      {
        directory: "/repo",
        payload: { type: "message.updated", properties: { sessionID: message.info.sessionID, info: message.info } },
      },
      {
        type: "session.next.reasoning.ended",
        properties: {
          sessionID: message.info.sessionID,
          providerMetadata: { model: hiddenSlug, provider: hiddenProvider },
        },
      },
      {
        type: "sync",
        syncEvent: {
          type: "session.next.step.started.1",
          data: {
            sessionID: message.info.sessionID,
            model: { id: hiddenAlias, providerID: hiddenProvider },
          },
        },
      },
      {
        type: "session.next.retried",
        data: {
          sessionID: message.info.sessionID,
          error: {
            message: hiddenSlug,
            isRetryable: true,
            responseBody: hiddenProvider,
            responseHeaders: { "x-provider": hiddenProvider },
          },
        },
      },
    ]

    const json = JSON.stringify(events.map(ArenaPrivacy.event))
    expect(json).not.toContain(hiddenAlias)
    expect(json).not.toContain(hiddenSlug)
    expect(json).not.toContain(hiddenProvider)
    expect(json).not.toContain("providerMetadata")
    expect(json).not.toContain("responseBody")
    expect(json).toContain('"id":"contestant"')
    expect(json).toContain("Arena contestant request failed")
  })

  test("redacts V2 context and settlement metrics and fails closed for unknown events", () => {
    process.env.OPENCODE_ARENA = "1"
    const step = ArenaPrivacy.event({
      type: "session.next.step.ended.2",
      metadata: { canonicalSlug: hiddenSlug, safe: "kept" },
      data: {
        sessionID: "ses_root",
        timestamp: 10,
        assistantMessageID: "msg_assistant",
        finish: "stop",
        cost: 9.5,
        tokens: { input: 20, output: 10, reasoning: 12, cache: { read: 3, write: 4 } },
        providerMetadata: { model: hiddenSlug, provider: hiddenProvider },
        snapshot: "tree-sha",
        files: ["src/index.ts"],
      },
    })
    const context = ArenaPrivacy.event({
      type: "session.next.context.updated",
      properties: {
        sessionID: "ses_root",
        timestamp: 11,
        messageID: "msg_context",
        text: `private system context for ${hiddenSlug}`,
        model: hiddenAlias,
      },
    })
    const future = ArenaPrivacy.event({
      directory: "/repo",
      payload: {
        type: "plugin.future.event",
        properties: {
          sessionID: "ses_root",
          label: "Timeline-safe value",
          model: hiddenAlias,
          nested: {
            provider: hiddenProvider,
            rawResponse: hiddenSlug,
            usage: { tokens: 42, cost: 9.5 },
            safe: "kept",
          },
        },
      },
    })

    expect(step).toEqual({
      type: "session.next.step.ended.2",
      metadata: { safe: "kept" },
      data: {
        sessionID: "ses_root",
        timestamp: 10,
        assistantMessageID: "msg_assistant",
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "tree-sha",
        files: ["src/index.ts"],
      },
    })
    expect(context).toEqual({
      type: "session.next.context.updated",
      properties: {
        sessionID: "ses_root",
        timestamp: 11,
        messageID: "msg_context",
        text: "",
      },
    })
    expect(future).toEqual({
      directory: "/repo",
      payload: {
        type: "plugin.future.event",
        properties: {
          sessionID: "ses_root",
          label: "Timeline-safe value",
          nested: { safe: "kept" },
        },
      },
    })
    const json = JSON.stringify([step, context, future])
    expect(json).not.toContain(hiddenAlias)
    expect(json).not.toContain(hiddenSlug)
    expect(json).not.toContain(hiddenProvider)
    expect(json).toContain("Timeline-safe value")
    expect(json).toContain("tree-sha")
  })

  test("hides catalogs and blocks model configuration mutations at HTTP boundaries", async () => {
    enableArenaControl()
    await using directory = await tmpdir({
      config: {
        formatter: false,
        lsp: false,
        username: "arena-user",
        model: `${hiddenProvider}/${hiddenAlias}`,
        small_model: `${hiddenProvider}/${hiddenAlias}`,
        provider: {
          [hiddenProvider]: {
            options: { baseURL: `https://${hiddenProvider}.invalid` },
            models: { [hiddenAlias]: { id: hiddenSlug } },
          },
        },
      },
    })
    const headers = { "x-opencode-directory": directory.path, "x-paseo-control-token": controlToken }
    const configResponse = await app().request("/config", { headers })
    const providerResponse = await app().request("/provider", { headers })
    const configProvidersResponse = await app().request("/config/providers", { headers })

    expect(configResponse.status).toBe(200)
    const config = await configResponse.json()
    expect(config).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      formatter: false,
      lsp: false,
      username: "arena-user",
    })
    expect(JSON.stringify(config)).not.toContain(hiddenAlias)
    expect(JSON.stringify(config)).not.toContain(hiddenSlug)
    expect(JSON.stringify(config)).not.toContain(hiddenProvider)
    expect(await providerResponse.json()).toEqual({ all: [], default: {}, connected: [] })
    expect(await configProvidersResponse.json()).toEqual({ providers: [], default: {} })

    const modelPatch = await app().request("/config", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: `${hiddenProvider}/${hiddenAlias}` }),
    })
    expect(modelPatch.status).toBe(400)

    const authMutation = await app().request(`/auth/${hiddenProvider}`, { method: "DELETE", headers })
    expect(authMutation.status).toBe(400)

    const ordinaryPatch = await app().request("/config", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ username: "changed", formatter: false, lsp: false }),
    })
    expect(ordinaryPatch.status).toBe(200)
    expect(await ordinaryPatch.json()).toMatchObject({ username: "changed" })
  })

  test("sanitizes session and message responses before they reach the browser", async () => {
    enableArenaControl()
    setStoreForTest({
      runs: { findOne: async () => null },
      chatForSession: async () => null,
    } as unknown as Store)
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
      "x-paseo-control-token": controlToken,
    }
    const createdResponse = await app().request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Arena",
        model: { id: hiddenAlias, providerID: hiddenProvider },
        metadata: { canonicalSlug: hiddenSlug, provider: hiddenProvider },
      }),
    })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.clone().json()
    if (typeof created !== "object" || created === null || !("id" in created) || typeof created.id !== "string") {
      throw new Error("Arena session response did not contain an ID")
    }

    await AppRuntime.runPromise(
      provideInstance(directory.path)(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const source = contestantMessage(SessionID.make(created.id))
          yield* sessions.updateMessage(source.info)
          yield* Effect.forEach(source.parts, (part) => sessions.updatePart(part))
        }),
      ),
    )
    const sessionResponse = await app().request(`/session/${created.id}`, { headers })
    const messageResponse = await app().request(`/session/${created.id}/message`, { headers })
    expect(sessionResponse.status).toBe(200)
    expect(messageResponse.status).toBe(200)

    for (const response of [createdResponse, sessionResponse, messageResponse]) {
      const json = await response.clone().text()
      expect(json).not.toContain(hiddenAlias)
      expect(json).not.toContain(hiddenSlug)
      expect(json).not.toContain(hiddenProvider)
    }
    expect(await sessionResponse.clone().text()).toContain('"providerID":"arena"')
    expect(await messageResponse.clone().text()).toContain('"modelID":"contestant"')
  })

  test("persists only blinded Arena session data while returning raw live values", async () => {
    process.env.OPENCODE_ARENA = "1"
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const rawCallID = "chatcmpl-tool-ab9145b12e6c558f"

    const result = await AppRuntime.runPromise(
      provideInstance(directory.path)(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const created = yield* sessions.create({
            title: "Arena persistence",
            model: { id: ModelV2.ID.make(hiddenAlias), providerID: ProviderV2.ID.make(hiddenProvider) },
            metadata: { canonicalSlug: hiddenSlug, provider: hiddenProvider },
          })
          const source = contestantMessage(created.id)
          const tool = source.parts.find((part) => part.type === "tool")
          if (!tool || tool.type !== "tool") throw new Error("Contestant fixture is missing its tool part")
          tool.callID = rawCallID

          const returnedMessage = yield* sessions.updateMessage(source.info)
          const returnedParts = yield* Effect.forEach(source.parts, (part) => sessions.updatePart(part))
          const reloaded = yield* sessions.messages({ sessionID: created.id })
          const { db } = yield* Database.Service
          const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get()
          const messages = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, created.id)).all()
          const parts = yield* db.select().from(PartTable).where(eq(PartTable.session_id, created.id)).all()
          const events = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()

          return { returnedMessage, returnedParts, reloaded, session, messages, parts, events }
        }),
      ),
    )

    const live = JSON.stringify({ message: result.returnedMessage, parts: result.returnedParts })
    const restoredReload = JSON.stringify(
      result.reloaded.map((message) => ({ ...message, parts: message.parts.map(ArenaPrivacy.restorePart) })),
    )
    const blindedReload = JSON.stringify(result.reloaded)
    const persisted = JSON.stringify({
      session: result.session,
      messages: result.messages,
      parts: result.parts,
      events: result.events,
    })
    expect(live).toContain(hiddenAlias)
    expect(live).toContain(hiddenProvider)
    expect(live).toContain(rawCallID)
    expect(restoredReload).toContain(rawCallID)
    expect(restoredReload).toContain("xai-responses-v1")
    expect(restoredReload).toContain('"providerExecuted":true')
    expect(blindedReload).not.toContain(rawCallID)
    expect(blindedReload).not.toContain("xai-responses-v1")
    expect(blindedReload).toContain("call_arena_")
    expect(persisted).not.toContain(hiddenAlias)
    expect(persisted).not.toContain(hiddenSlug)
    expect(persisted).not.toContain(hiddenProvider)
    expect(persisted).not.toContain(rawCallID)
    expect(persisted).not.toContain("xai-responses-v1")
    expect(persisted).toContain("call_arena_")
    expect(result.session).toMatchObject({
      model: { id: "contestant", providerID: "arena" },
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    })
  })

  test("persists contestant instructions for the model while live output hides them", async () => {
    process.env.OPENCODE_ARENA = "1"
    await using directory = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const instructions = "Use PASEO_PORT for the primary listener and report ARENA_PREVIEW_URL."

    const result = await AppRuntime.runPromise(
      provideInstance(directory.path)(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const created = yield* sessions.create({ title: "Arena instructions" })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: created.id,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: ProviderV2.ID.make(hiddenProvider), modelID: ModelV2.ID.make(hiddenAlias) },
            system: instructions,
          })
          const reloaded = yield* sessions.messages({ sessionID: created.id })
          const { db } = yield* Database.Service
          const messages = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, created.id)).all()
          return { reloaded, messages }
        }),
      ),
    )

    const user = result.reloaded.find((message) => message.info.role === "user")?.info
    if (user?.role !== "user") throw new Error("Arena instructions fixture is missing its user message")
    const persisted = JSON.stringify(result.messages)
    expect(user.system).toBe(instructions)
    expect(persisted).toContain(instructions)
    expect(persisted).not.toContain(hiddenAlias)
    expect(persisted).not.toContain(hiddenProvider)
    const live = ArenaPrivacy.messageInfo(user)
    expect(live.role === "user" ? live.system : undefined).toBeUndefined()
  })

  test("preserves DateTime values while blinding durable session.next events", () => {
    process.env.OPENCODE_ARENA = "1"
    const persisted = ArenaPrivacy.persistedEventData(SessionEvent.Step.Started, {
      sessionID: SessionID.make("ses_arena_timestamp"),
      assistantMessageID: MessageID.make("msg_arena_timestamp"),
      timestamp: DateTime.makeUnsafe(123),
      agent: "build",
      model: { id: ModelV2.ID.make(hiddenAlias), providerID: ProviderV2.ID.make(hiddenProvider) },
    })

    expect(DateTime.toEpochMillis(persisted.timestamp)).toBe(123)
    expect(persisted.model).toEqual({ id: ModelV2.ID.make("contestant"), providerID: ProviderV2.ID.make("arena") })
  })

  test("restores only continuation metadata instead of retaining complete tool output", () => {
    process.env.OPENCODE_ARENA = "1"
    const source = contestantMessage()
    const tool = source.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
    if (!tool || tool.state.status !== "completed") throw new Error("Contestant fixture is missing its completed tool")
    tool.callID = "call-7529b035-5fd4-43dc-a17a-59c78f463f27-0"
    tool.state.output = "large original output"
    ArenaPrivacy.rememberPart(tool)

    const durable = ArenaPrivacy.part(tool)
    if (durable.type !== "tool" || durable.state.status !== "completed") {
      throw new Error("Durable fixture is not a completed tool")
    }
    const current = {
      ...durable,
      state: { ...durable.state, output: "new output loaded from SQLite" },
    }
    const restored = ArenaPrivacy.restorePart(current)

    expect(restored.callID).toBe(tool.callID)
    expect(restored.metadata).toEqual(tool.metadata)
    expect(restored.state.output).toBe("new output loaded from SQLite")

    ArenaPrivacy.forgetSession(tool.sessionID)
    expect(ArenaPrivacy.restorePart(current)).toEqual(current)
  })

  test("sanitizes global SSE events before serialization", async () => {
    enableArenaControl()
    const listeners = GlobalBus.listenerCount("event")
    const stream = sse(await app().request("/global/event", { headers: { "x-paseo-control-token": controlToken } }))
    await stream.next()
    const next = stream.next()
    const deadline = Date.now() + 5_000
    while (GlobalBus.listenerCount("event") <= listeners) {
      if (Date.now() >= deadline) throw new Error("global SSE listener did not become ready")
      await Bun.sleep(1)
    }

    const message = contestantMessage()
    GlobalBus.emit("event", {
      directory: "/repo",
      payload: {
        type: "message.updated",
        properties: { sessionID: message.info.sessionID, info: message.info },
      },
    })

    const json = JSON.stringify(await next)
    await stream.reader.cancel()
    expect(json).not.toContain(hiddenAlias)
    expect(json).not.toContain(hiddenSlug)
    expect(json).not.toContain(hiddenProvider)
    expect(json).not.toContain("responseBody")
    expect(json).toContain('"providerID":"arena"')
    expect(json).toContain('"modelID":"contestant"')
  })
})
