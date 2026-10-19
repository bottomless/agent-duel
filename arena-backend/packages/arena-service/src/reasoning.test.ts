import { expect, test } from "bun:test"
import { createReasoningRedactor, REDACTED_THINKING } from "./reasoning"

const binding = { userId: "user", scopeID: "turn", assignmentID: "assignment" }

test("leaves ordinary content and empty reasoning chunks alone", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const input = {
    choices: [{ index: 0, delta: { content: "Visible answer", reasoning: null, reasoning_details: [] } }],
  }
  expect(redactor.redact(input, true)).toEqual({ choices: [{ index: 0, delta: { content: "Visible answer" } }] })
  expect(input.choices[0]?.delta.reasoning).toBeNull()
})

test("redacts JSON reasoning and restores the exact continuation without changing tools or text", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const message = {
    role: "assistant",
    content: "Let me check.",
    reasoning: "I am the secret model",
    reasoning_content: "Private reasoning alias",
    reasoning_details: [
      {
        type: "reasoning.text",
        text: "Private thinking",
        signature: "private-signature",
        format: "anthropic-claude-v1",
      },
      { type: "reasoning.encrypted", data: "private-encrypted", format: "openai-responses-v1" },
    ],
    tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: '{"path":"file"}' } }],
  }
  const response = redactor.redact({ choices: [{ message }] }) as { choices: [{ message: typeof message }] }
  expect(JSON.stringify(response)).not.toContain("private-")
  expect(JSON.stringify(response)).not.toContain("Private")
  expect(JSON.stringify(response)).not.toContain("secret model")
  expect(JSON.stringify(response)).not.toContain("anthropic")
  expect(JSON.stringify(response)).not.toContain("openai")
  expect(response.choices[0].message.reasoning).toBe(REDACTED_THINKING)
  const input = { messages: [response.choices[0].message], reasoning: { effort: "high" } }
  expect(createReasoningRedactor("server-key", binding).restore(input)).toEqual({
    messages: [message],
    reasoning: { effort: "high" },
  })
})

test("preserves every streamed packet and late signature for the next tool step", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const original = [
    { reasoning_details: [{ type: "reasoning.text", text: "First ", format: "anthropic-claude-v1", index: 0 }] },
    { reasoning_details: [{ type: "reasoning.text", text: "second", signature: "signed", index: 0 }] },
    { reasoning_details: [{ type: "reasoning.encrypted", data: "secret", format: "openai-responses-v1", index: 1 }] },
  ] as const
  const details = original.flatMap((delta) => {
    const result = redactor.redact({ choices: [{ delta }] }, true) as {
      choices: [{ delta: { reasoning_details: unknown[] } }]
    }
    expect(JSON.stringify(result)).not.toContain("First")
    expect(JSON.stringify(result)).not.toContain("second")
    expect(JSON.stringify(result)).not.toContain("signed")
    return result.choices[0].delta.reasoning_details
  })
  expect(
    redactor.restore({ messages: [{ role: "assistant", reasoning: REDACTED_THINKING, reasoning_details: details }] }),
  ).toEqual({
    messages: [
      {
        role: "assistant",
        reasoning: "First second",
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "First second",
            signature: "signed",
            format: "anthropic-claude-v1",
            index: 0,
          },
          original[2].reasoning_details[0],
        ],
      },
    ],
  })
})

test("rejects tampered reasoning and replay across users, turns, assignments, or server keys", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const result = redactor.redact({ choices: [{ message: { role: "assistant", reasoning: "secret" } }] }) as {
    choices: [{ message: Record<string, unknown> }]
  }
  const input = { messages: [result.choices[0].message] }
  for (const other of [
    { ...binding, userId: "other" },
    { ...binding, scopeID: "other" },
    { ...binding, assignmentID: "other" },
  ])
    expect(() => createReasoningRedactor("server-key", other).restore(input)).toThrow(
      "Invalid Arena reasoning continuation",
    )
  expect(() => createReasoningRedactor("another-key", binding).restore(input)).toThrow(
    "Invalid Arena reasoning continuation",
  )
  const tampered = JSON.parse(JSON.stringify(input).replace("arena_reasoning_v1.", "arena_reasoning_v1.tampered"))
  expect(() => redactor.restore(tampered)).toThrow("Invalid Arena reasoning continuation")
})

test("redacts Responses items and progress events and restores their original continuation", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const item = {
    type: "reasoning",
    id: "rs_provider",
    summary: [{ type: "summary_text", text: "Private summary" }],
    encrypted_content: "provider-ciphertext",
  }
  const response = redactor.redact({
    output: [item, { type: "message", content: [{ type: "output_text", text: "Done" }] }],
  }) as { output: unknown[] }
  expect(JSON.stringify(response)).not.toContain("Private")
  expect(JSON.stringify(response)).not.toContain("provider")
  expect(redactor.restore({ input: response.output })).toEqual({
    input: [item, { type: "message", content: [{ type: "output_text", text: "Done" }] }],
  })
  for (const type of ["response.reasoning_text.delta", "response.reasoning_summary_text.delta"]) {
    const event = redactor.redact({ type, item_id: "rs_provider", delta: "Private thought", output_index: 0 }, true)
    expect(event).toMatchObject({ type, delta: REDACTED_THINKING, output_index: 0 })
    expect(JSON.stringify(event)).not.toContain("provider")
    expect(JSON.stringify(event)).not.toContain("Private")
  }
})
