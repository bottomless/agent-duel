import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { createReasoningRedactor, REDACTED_THINKING } from "@agent-duel/arena-service/reasoning"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { expireCopiedReasoning, reasoningContext } from "@/arena/reasoning"
import { AssignmentRegistry } from "@/arena/proxy"

const binding = { userId: "fixture-account", scopeID: "fixture-turn", assignmentID: "fixture-assignment" }
const key = "fixture-key"
const marker = { type: "reasoning.text", text: REDACTED_THINKING, id: "arena_redacted_thinking" }
const model = { providerID: "arena", id: "contestant" }
const decode = Schema.decodeUnknownSync(SessionMessage.Assistant)

function sealed() {
  const raw = {
    choices: [
      {
        message: {
          reasoning_details: [
            { type: "reasoning.text", text: "private thought", signature: "fixture-signature" },
            { type: "reasoning.encrypted", data: "opaque-upstream-state" },
          ],
        },
      },
    ],
  }
  const safe = createReasoningRedactor(key, binding).redact(raw)
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      choices: Schema.Array(
        Schema.Struct({ message: Schema.Struct({ reasoning_details: Schema.Array(Schema.Unknown) }) }),
      ),
    }),
  )(safe)
  return result.choices[0].message.reasoning_details
}

function assistant(id = "msg_20", details = sealed()) {
  return decode({
    id,
    type: "assistant",
    agent: "build",
    model,
    time: { created: 0, completed: 1 },
    content: [
      { type: "reasoning", text: REDACTED_THINKING, native: { reasoning_details: details } },
      { type: "text", text: "Half an answer: ```json\n{", native: { reasoning_details: details, unrelated: [] } },
      {
        type: "tool",
        id: "call_fixture",
        name: "read",
        state: { status: "completed", input: { path: "fixture" }, content: [{ type: "text", text: "fixture result" }] },
        time: { created: 0, completed: 1 },
      },
      { type: "text", text: "[The response was interrupted]" },
      { type: "text", text: '"done": true}\n```' },
    ],
  })
}

function lowered(message: SessionMessage.Assistant, from?: string) {
  return reasoningContext(toLLMMessages([message], message.model, "openrouter"), from)
}

function restored(messages: Message[]) {
  const reasoning = messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === "reasoning" ? (part.providerMetadata?.openrouter?.reasoning_details ?? []) : [],
    ),
  )
  return createReasoningRedactor(key, binding).restore({
    messages: [{ role: "assistant", content: "reply", reasoning_details: reasoning }],
  })
}

describe("sealed reasoning assignment boundaries", () => {
  test("expires copied winner state without joining cut-stream text, changing tools, or mutating the source", () => {
    const source = assistant()
    const before = JSON.stringify(source)
    const copy = expireCopiedReasoning(source)
    expect(JSON.stringify(copy)).not.toContain("arena_reasoning_v1.")
    expect(copy.type).toBe("assistant")
    if (copy.type !== "assistant") throw new Error("assistant expected")
    expect(copy.content.map((part) => part.type)).toEqual(source.content.map((part) => part.type))
    expect(copy.content.map((part) => (part.type === "tool" ? part : part.text))).toEqual(
      source.content.map((part) =>
        part.type === "tool" ? { ...part, native: undefined } : part.text,
      ),
    )
    expect(copy.content[1]).toMatchObject({ native: { unrelated: [] } })
    expect(JSON.stringify(lowered(copy))).not.toContain(REDACTED_THINKING)
    expect(JSON.stringify(source)).toBe(before)
  })

  test("Battle-off expires the earlier scope at request time and keeps the current tool loop", () => {
    const old = assistant("msg_10")
    const current = assistant("msg_30")
    const history = toLLMMessages([old, current], current.model, "openrouter")
    const before = JSON.stringify(history)
    const sent = reasoningContext(history, "msg_20")
    const previous = sent.filter((message) => message.id === old.id)
    expect(JSON.stringify(previous)).not.toContain("arena_reasoning_v1.")
    expect(JSON.stringify(previous)).not.toContain(REDACTED_THINKING)
    expect(sent.find((message) => message.id === current.id)).toEqual(
      history.find((message) => message.id === current.id),
    )
    expect(JSON.stringify(history)).toBe(before)
  })

  test("Battle-off retry and restored scope keep current reasoning until the next prompt", () => {
    const previous = assistant("msg_10")
    const current = assistant("msg_30")
    const history = toLLMMessages([previous, current], current.model, "openrouter")
    const assignment = {
      runID: "single-agent-fixture",
      rootSessionID: "fixture-session",
      scopeID: binding.scopeID,
      assignmentID: binding.assignmentID,
      reasoningFromMessageID: "msg_20",
      telemetry: false,
    }
    const registry = new AssignmentRegistry()
    registry.replaceSingle(assignment.rootSessionID, assignment)
    const send = (registry: AssignmentRegistry) =>
      reasoningContext(history, registry.resolve(assignment.rootSessionID).reasoningFromMessageID)
    const first = send(registry)
    expect(send(registry)).toEqual(first)
    const restarted = new AssignmentRegistry()
    restarted.replaceSingle(assignment.rootSessionID, JSON.parse(JSON.stringify(assignment)))
    expect(send(restarted)).toEqual(first)
    expect(JSON.stringify(first.find((message) => message.id === current.id))).toContain("arena_reasoning_v1.")
    restarted.replaceSingle(assignment.rootSessionID, {
      ...assignment,
      runID: "next-scope",
      scopeID: "next-scope",
      assignmentID: "next-assignment",
      reasoningFromMessageID: "msg_40",
    })
    expect(JSON.stringify(send(restarted))).not.toContain("arena_reasoning_v1.")
  })

  test("same-assignment tool continuation restores signed and opaque reasoning", () => {
    expect(restored(lowered(assistant()))).toMatchObject({
      messages: [
        {
          reasoning_details: [
            { type: "reasoning.text", text: "private thought", signature: "fixture-signature" },
            { type: "reasoning.encrypted", data: "opaque-upstream-state" },
          ],
        },
      ],
    })
  })

  test("retrying the same assignment preserves identical envelopes", () => {
    const history = assistant()
    const first = lowered(history)
    const retry = lowered(history)
    expect(retry).toEqual(first)
    expect(restored(retry)).toEqual(restored(first))
  })

  test("serialized history and a rebuilt assignment registry preserve replay after restart", () => {
    const original = assistant()
    const stored = JSON.stringify(Schema.encodeSync(SessionMessage.Assistant)(original))
    const assignment = { runID: "fixture-run", rootSessionID: "fixture-session", ...binding, telemetry: true }
    const restarted = new AssignmentRegistry()
    restarted.assign(assignment.rootSessionID, assignment)
    const recovered = decode(JSON.parse(stored))
    expect(lowered(recovered, restarted.resolve(assignment.rootSessionID).reasoningFromMessageID)).toEqual(
      lowered(original),
    )
    expect(restored(lowered(recovered))).toEqual(restored(lowered(original)))
  })

  test("reasoning-only assistants are omitted, but tool calls and their results remain", () => {
    const thought = assistant()
    const onlyReasoning = { ...thought, content: thought.content.filter((part) => part.type === "reasoning") }
    expect(lowered(onlyReasoning)).toEqual([])
    expect(reasoningContext([Message.assistant([{ type: "reasoning", text: "" }])])).toEqual([])
    expect(
      reasoningContext([
        Message.assistant([
          { type: "reasoning", text: "" },
          { type: "text", text: " \n" },
        ]),
      ]),
    ).toEqual([])
    const onlyTool = {
      ...thought,
      content: thought.content.filter((part) => part.type === "tool" || part.type === "reasoning"),
    }
    const sent = lowered(onlyTool)
    expect(sent.map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(sent[0].content.map((part) => part.type)).toEqual(["reasoning", "tool-call"])
  })

  test("a later assignment cannot open the original envelope", () => {
    const input = { messages: [{ role: "assistant", content: "reply", reasoning_details: sealed() }] }
    expect(createReasoningRedactor(key, { ...binding, assignmentID: "next-battle" }).restore(input)).toEqual({
      messages: [{ role: "assistant", content: "reply" }],
    })
    expect(createReasoningRedactor(key, { ...binding, scopeID: "next-message" }).restore(input)).toEqual({
      messages: [{ role: "assistant", content: "reply" }],
    })
  })

  test("unsigned, non-Arena provider state remains untouched", () => {
    const source = assistant("msg_20", [marker])
    const native = decode({
      ...Schema.encodeSync(SessionMessage.Assistant)(source),
      model: { providerID: "other", id: "model" },
    })
    expect(expireCopiedReasoning(native)).toBe(native)
  })
})
