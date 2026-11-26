import { expect, test } from "bun:test"
import { z } from "zod"
import { createReasoningRedactor, REDACTED_THINKING } from "./reasoning"

const binding = { userId: "user", scopeID: "turn", assignmentID: "assignment" }

test("batches tiny reasoning fragments into a compact, lossless continuation", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const details: unknown[] = []
  for (let index = 0; index < 16_384; index++) {
    const result = redactor.redact(
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "abcd", format: "anthropic-claude-v1", index: 0 }],
            },
          },
        ],
      },
      true,
    ) as { choices: [{ delta: { reasoning_details: unknown[] } }] }
    details.push(...result.choices[0].delta.reasoning_details)
  }
  const end = redactor.redact(
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_details: [{ type: "reasoning.text", text: "", signature: "late-signature", index: 0 }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    true,
  ) as { choices: [{ delta: { reasoning_details: unknown[] } }] }
  details.push(...end.choices[0].delta.reasoning_details)
  // The SDK coalesces adjacent neutral text markers; measure only continuation envelopes here.
  const encrypted = details.filter((detail) => (detail as { type: string }).type === "reasoning.encrypted")
  expect(encrypted.length).toBeGreaterThan(1)
  const input = { messages: [{ role: "assistant", content: "", reasoning_details: encrypted }] }
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(256 * 1024)
  expect(createReasoningRedactor("server-key", binding).restore(input)).toEqual({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "abcd".repeat(16_384),
            format: "anthropic-claude-v1",
            index: 0,
            signature: "late-signature",
          },
        ],
      },
    ],
  })
})

test("leaves ordinary content and empty reasoning chunks alone", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const input = {
    choices: [{ index: 0, delta: { content: "Visible answer", reasoning: null, reasoning_details: [] } }],
  }
  expect(redactor.redact(input, true)).toEqual({ choices: [{ index: 0, delta: { content: "Visible answer" } }] })
  expect(input.choices[0]?.delta.reasoning).toBeNull()
})

test("keeps interleaved choices separate, flushes at content, and preserves late signatures", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const collected = new Map<number, unknown[]>()
  const collect = (value: unknown) => {
    const result = value as { choices: { index: number; delta: { reasoning_details?: unknown[] } }[] }
    for (const choice of result.choices) {
      const details = collected.get(choice.index) ?? []
      details.push(...(choice.delta.reasoning_details ?? []))
      collected.set(choice.index, details)
    }
  }
  collect(
    redactor.redact(
      {
        choices: [0, 1].map((index) => ({
          index,
          delta: {
            reasoning_details: [{ type: "reasoning.text", text: `private-${index}`, index: 0 }],
          },
        })),
      },
      true,
    ),
  )
  collect(redactor.redact({ choices: [{ index: 0, delta: { content: "Visible answer" } }] }, true))
  collect(
    redactor.redact(
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.text", text: "", signature: "late-signature", index: 0 }] },
            finish_reason: "stop",
          },
        ],
      },
      true,
    ),
  )
  collect(redactor.flush())
  expect(redactor.flush()).toBeUndefined()
  for (const index of [0, 1]) {
    expect(redactor.restore({ messages: [{ role: "assistant", reasoning_details: collected.get(index) }] })).toEqual({
      messages: [
        {
          role: "assistant",
          reasoning_details: [
            {
              type: "reasoning.text",
              text: `private-${index}`,
              index: 0,
              ...(index === 0 ? { signature: "late-signature" } : {}),
            },
          ],
        },
      ],
    })
  }
})

test("discards buffered reasoning when a stream is cancelled", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  redactor.redact({ choices: [{ delta: { reasoning: "private" } }] }, true)
  redactor.clear()
  expect(redactor.flush()).toBeUndefined()
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
  const { reasoning: _reasoning, reasoning_content: _reasoningContent, ...deduplicated } = message
  expect(createReasoningRedactor("server-key", binding).restore(input)).toEqual({
    messages: [deduplicated],
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
  const details = [...original, {}].flatMap((delta, index) => {
    const result = redactor.redact(
      { choices: [{ delta, finish_reason: index === original.length ? "tool_calls" : null }] },
      true,
    ) as {
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

test("drops reasoning sealed for another user, turn, assignment, or server key instead of failing", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const result = redactor.redact({ choices: [{ message: { role: "assistant", reasoning: "secret" } }] }) as {
    choices: [{ message: Record<string, unknown> }]
  }
  const input = {
    messages: [
      { role: "user", content: "next" },
      { ...result.choices[0].message, content: "Done" },
    ],
  }
  const dropped = {
    messages: [
      { role: "user", content: "next" },
      { role: "assistant", content: "Done" },
    ],
  }
  for (const other of [
    { ...binding, userId: "other" },
    { ...binding, scopeID: "other" },
    { ...binding, assignmentID: "other" },
  ])
    expect(createReasoningRedactor("server-key", other).restore(input)).toEqual(dropped)
  expect(createReasoningRedactor("another-key", binding).restore(input)).toEqual(dropped)
  const tampered = JSON.parse(JSON.stringify(input).replace("arena_reasoning_v1.", "arena_reasoning_v1.tampered"))
  expect(redactor.restore(tampered)).toEqual(dropped)
})

test("a single-agent follow-up keeps current reasoning and drops the previous message's", () => {
  const stream = (redactor: ReturnType<typeof createReasoningRedactor>, text: string) => {
    const details: Record<string, unknown>[] = []
    for (const chunk of [
      { choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text, index: 0 }] } }] },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.text", text: "", signature: "sig", index: 0 }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]) {
      const value = redactor.redact(chunk, true) as {
        choices: [{ delta: { reasoning_details?: Record<string, unknown>[] } }]
      }
      details.push(...(value.choices[0].delta.reasoning_details ?? []))
    }
    return { role: "assistant", content: "", reasoning: REDACTED_THINKING, reasoning_details: details }
  }
  const first = stream(createReasoningRedactor("server-key", { ...binding, scopeID: "message-1" }), "Old plan")
  const second = createReasoningRedactor("server-key", { ...binding, scopeID: "message-2" })
  const current = stream(second, "New plan")
  const restored = second.restore({ messages: [first, { role: "user", content: "next" }, current] }) as {
    messages: Record<string, unknown>[]
  }
  expect(restored.messages[0]).toEqual({ role: "assistant", content: "" })
  expect(restored.messages[2]).toMatchObject({
    reasoning_details: [{ type: "reasoning.text", text: "New plan", signature: "sig" }],
  })
  expect(restored.messages[2]).not.toHaveProperty("reasoning")
  expect(JSON.stringify(restored)).not.toContain(REDACTED_THINKING)
  expect(JSON.stringify(restored)).not.toContain("Old plan")
})

test("omits duplicate plaintext reasoning when reasoning_details is present, but preserves plaintext-only reasoning", () => {
  const redactor = createReasoningRedactor("server-key", binding)
  const both = redactor.redact({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Done",
          reasoning: "DeepSeek thought",
          reasoning_details: [{ type: "reasoning.text", text: "DeepSeek thought", format: "unknown", index: 0 }],
        },
      },
    ],
  }) as { choices: [{ message: Record<string, unknown> }] }
  const restoredBoth = redactor.restore({ messages: [both.choices[0].message] }) as {
    messages: Record<string, unknown>[]
  }
  expect(restoredBoth.messages[0]).toEqual({
    role: "assistant",
    content: "Done",
    reasoning_details: [{ type: "reasoning.text", text: "DeepSeek thought", format: "unknown", index: 0 }],
  })
  expect(restoredBoth.messages[0]).not.toHaveProperty("reasoning")
  expect(restoredBoth.messages[0]).not.toHaveProperty("reasoning_content")

  const plainOnly = redactor.redact({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Plain",
          reasoning: "Only string reasoning",
        },
      },
    ],
  }) as { choices: [{ message: Record<string, unknown> }] }
  const restoredPlain = redactor.restore({ messages: [plainOnly.choices[0].message] }) as {
    messages: Record<string, unknown>[]
  }
  expect(restoredPlain.messages[0]).toEqual({
    role: "assistant",
    content: "Plain",
    reasoning: "Only string reasoning",
  })
})

test.each(["reasoning", "reasoning_content"])(
  "preserves plaintext-only stream fragments in %s beside structured details",
  (field) => {
    const redactor = createReasoningRedactor("server-key", binding)
    const first = { type: "reasoning.text", text: "Structured thought", format: "anthropic-claude-v1", index: 0 }
    const signature = { type: "reasoning.text", text: "", signature: "late-signature", index: 0 }
    const opaque = { type: "reasoning.encrypted", data: "provider-ciphertext", format: "openai-responses-v1", index: 1 }
    const chunks = [
      { delta: { [field]: "Plain start. " } },
      { delta: { [field]: first.text, reasoning_details: [first] } },
      { delta: { [field]: "Plain end.", reasoning_details: [] } },
      { delta: { reasoning_details: [signature, opaque] }, finish_reason: "tool_calls" },
    ]
    const redactedStream = z.object({
      choices: z.tuple([
        z.object({ delta: z.object({ reasoning_details: z.array(z.looseObject({ type: z.string() })) }) }),
      ]),
    })
    const details = chunks.flatMap((choice) => {
      const redacted = redactedStream.parse(redactor.redact({ choices: [choice] }, true))
      return redacted.choices[0].delta.reasoning_details
    })
    // Plain and structured fragments can share one continuation envelope.
    expect(details.filter((detail) => detail.type === "reasoning.encrypted")).toHaveLength(1)
    expect(JSON.stringify(details)).not.toContain("Plain start")
    expect(
      createReasoningRedactor("server-key", binding).restore({
        messages: [{ role: "assistant", reasoning: REDACTED_THINKING, reasoning_details: details }],
      }),
    ).toEqual({
      messages: [
        {
          role: "assistant",
          [field]: "Plain start. Plain end.",
          reasoning_details: [{ ...first, signature: signature.signature }, opaque],
        },
      ],
    })
  },
)

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
