import { expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { replayToolCalls } from "@/arena/engine-runtime/replay-tool-calls"

const legacy = "call_arena_84221a26b6af6aace009ea1ba6db09d2"

// Each result carries the same label as its call's input. The later steps reuse both IDs and finish
// their parallel reads in reverse order; matching on just the tool name or array position is wrong.
function step(n: number) {
  const ids = ["read_0", legacy, `unique_${n}`]
  const calls = ids.map((id, index) => ({
    type: "tool-call" as const,
    id,
    name: "read",
    input: { id: `${n}:${index}` },
  }))
  return [
    Message.make({ id: `msg_${n}`, role: "assistant", content: calls }),
    ...calls.toReversed().map((call) => Message.tool({ id: call.id, name: "read", result: call.input.id })),
  ]
}

test("repairs raw and already-blinded collisions on outbound replay without changing a previous step", () => {
  const history = [1, 2, 3, 4].flatMap(step)
  const original = JSON.stringify(history)
  const fixed = replayToolCalls(history)
  const calls = new Map<string, unknown>()
  for (const [position, message] of fixed.entries()) {
    if (message.role === "assistant") {
      for (const call of message.content) {
        if (call.type !== "tool-call") throw new Error("Expected a tool call")
        expect(calls.has(call.id)).toBe(false)
        calls.set(call.id, call.input)
        if (position && !call.id.startsWith("unique")) expect(call.id).toMatch(/^call_arena_[0-9a-f]{32}$/)
      }
    } else if (message.role === "tool") {
      const [output] = message.content
      expect(calls.get(output.id)).toEqual({ id: output.result.value })
    }
  }
  expect(calls.size).toBe(12)
  for (let n = 1; n <= 4; n++) {
    expect(calls.has(`unique_${n}`)).toBe(true)
    const prefix = n * step(n).length
    expect(replayToolCalls(history.slice(0, prefix))).toEqual(fixed.slice(0, prefix))
  }
  expect(fixed[0]).toEqual(history[0])
  expect(replayToolCalls(fixed)).toEqual(fixed)
  expect(JSON.stringify(history)).toBe(original)
})

test("changes the inline result of a provider-executed call without changing its replay metadata", () => {
  const call = { type: "tool-call" as const, id: "tool_0", name: "lookup", input: {}, providerExecuted: true }
  const result = {
    type: "tool-result" as const,
    id: call.id,
    name: call.name,
    result: { type: "text" as const, value: "ok" },
    providerExecuted: true,
    providerMetadata: { openrouter: { signature: "replay" } },
  }
  const message = Message.assistant([call, result])
  const second = replayToolCalls([message, message])[1]
  if (second.role !== "assistant") throw new Error("Expected assistant")
  const [fixed] = second.content
  if (fixed.type !== "tool-call") throw new Error("Expected tool call")
  expect(fixed.id).not.toBe(call.id)
  expect(second.content).toEqual([
    { ...call, id: fixed.id },
    { ...result, id: fixed.id },
  ])
})
