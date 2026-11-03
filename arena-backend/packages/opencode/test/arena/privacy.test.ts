import { afterEach, describe, expect, test } from "bun:test"
import { Model as ModelV2 } from "@opencode/schema/model"
import { Provider as ProviderV2 } from "@opencode/schema/provider"
import { SessionV1 } from "@/arena/session-shape"
import { SessionEvent } from "@opencode/schema/session-event"
import { setArenaCredentials } from "@/arena/credentials"
import { ArenaAttachments } from "@/arena/attachments"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
import { requestTooLargeMessage } from "@agent-duel/arena-service/request-error"
import { ArenaPrivacy } from "@/arena/privacy"
import { SessionRetry } from "@/session/retry"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { DateTime, Schema } from "effect"
import { sanitizeV2 } from "@/arena/v2-privacy"

const hiddenAlias = "arena-01"
const hiddenSlug = "anthropic/claude-opus-5-20260723"
const hiddenProvider = "secret-provider"
function enableArenaControl() {
  process.env.OPENCODE_ARENA = "1"
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

afterEach(() => {
  setArenaCredentials(undefined)
  delete process.env.OPENCODE_ARENA
})

describe("ArenaPrivacy", () => {
  test("keeps neutral idle recovery status and exhaustion while stripping provider details", () => {
    enableArenaControl()
    expect(
      ArenaPrivacy.status({ type: "retry", attempt: 2, message: ArenaResponseRecovery.IDLE_RECOVERING, next: 0 }),
    ).toMatchObject({ message: ArenaResponseRecovery.IDLE_RECOVERING, attempt: 2 })
    const message = contestantMessage()
    if (message.info.role !== "assistant") throw new Error("Expected assistant fixture")
    message.info.error = {
      name: "APIError",
      data: { message: ArenaResponseRecovery.IDLE_EXHAUSTED, isRetryable: false, responseBody: hiddenSlug },
    }
    const result = ArenaPrivacy.messages([message])[0]!
    expect(result.info).toMatchObject({
      error: { data: { message: ArenaResponseRecovery.IDLE_EXHAUSTED, isRetryable: false } },
    })
    expect(JSON.stringify(result)).not.toContain(hiddenSlug)
  })

  test("keeps the request-too-large explanation while stripping provider details", () => {
    enableArenaControl()
    const message = contestantMessage()
    if (message.info.role !== "assistant") throw new Error("Expected assistant fixture")
    message.info.error = {
      name: "APIError",
      data: { message: requestTooLargeMessage, isRetryable: false, responseBody: hiddenSlug },
    }
    const result = ArenaPrivacy.messages([message])[0]!
    expect(result.info).toMatchObject({ error: { data: { message: requestTooLargeMessage, isRetryable: false } } })
    expect(JSON.stringify(result)).not.toContain(hiddenSlug)
  })

  test("keeps only the synthetic replay marker needed by the durable output-limit budget", () => {
    enableArenaControl()
    const part = contestantMessage().parts.find((part) => part.type === "text")!
    expect(
      ArenaPrivacy.part({ ...part, synthetic: true, metadata: { arena_compaction_replay: true, model: hiddenSlug } }),
    ).toMatchObject({ metadata: { arena_compaction_replay: true } })
    expect(ArenaPrivacy.part({ ...part, metadata: { arena_compaction_replay: true } })).toMatchObject({
      metadata: undefined,
    })
  })

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

  test("replaces every retry message except the shared offline wait", () => {
    process.env.OPENCODE_ARENA = "1"
    const retry = { type: "retry" as const, attempt: 2, next: 10 }
    expect(ArenaPrivacy.status({ ...retry, message: `${hiddenProvider} is overloaded` })).toEqual({
      ...retry,
      message: "Arena contestant is retrying",
      action: undefined,
    })
    expect(ArenaPrivacy.status({ ...retry, message: SessionRetry.ARENA_OFFLINE_MESSAGE })).toEqual({
      ...retry,
      message: "Waiting for network",
      action: undefined,
    })
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

  test("preserves dispatch time through the native event codec and privacy boundary", () => {
    const data = Schema.encodeSync(SessionEvent.Step.Started.data)({
      sessionID: SessionID.make("ses_arena_timestamp"),
      assistantMessageID: MessageID.make("msg_arena_timestamp"),
      timestamp: DateTime.makeUnsafe(123),
      started: 123,
      agent: "build",
      model: { id: ModelV2.ID.make(hiddenAlias), providerID: ProviderV2.ID.make(hiddenProvider) },
    })
    const envelope = sanitizeV2({ type: SessionEvent.Step.Started.type, data }) as { data: unknown }
    const persisted = Schema.decodeUnknownSync(SessionEvent.Step.Started.data)(envelope.data)
    expect(persisted.started).toBe(123)
    expect(persisted.model).toEqual({ id: "contestant", providerID: "arena" })
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
})
