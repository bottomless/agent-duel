import { expect, test } from "bun:test"
import { z } from "zod"
import { compactionPolicy, reasoningShare } from "./compaction-policy"
import { eligibleForCompaction } from "./compaction-policy-contract"
import { createReasoningRedactor } from "./reasoning"

test("requires two completed turns and at least twenty percent measurable reasoning", () => {
  expect(eligibleForCompaction(1, 0.9)).toBe(false)
  expect(eligibleForCompaction(2, 0.2)).toBe(true)
  expect(eligibleForCompaction(3, 0.19999)).toBe(false)
  for (const share of [null, NaN, Infinity, -1, 1.1]) expect(eligibleForCompaction(4, share)).toBe(false)
})

test("uses reference tokens, counts message/tool text, and deduplicates reasoning fields", () => {
  const messages = [
    { role: "system", content: "Hello world" },
    {
      role: "user",
      content: [
        { type: "text", text: "Hello world" },
        { type: "image_url", image_url: { url: "x".repeat(10000) } },
      ],
    },
    {
      role: "assistant",
      content: "Hello world",
      reasoning: "Hello world",
      reasoning_details: [{ type: "reasoning.text", text: "Hello world" }],
    },
  ]
  // Two reasoning tokens / (two reasoning + eight non-reasoning, including two newlines).
  expect(reasoningShare(messages)).toBe(0.2)
  expect(
    reasoningShare([...messages, { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "{}" } }] }]),
  ).toBeLessThan(0.2)
  expect(
    reasoningShare([{ role: "assistant", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] }]),
  ).toBeNull()
  expect(reasoningShare([{ role: "assistant", reasoning: "[Thinking redacted]" }])).toBeNull()
  expect(reasoningShare([{ role: "user", content: "<|endoftext|>" }])).toBe(0)
})

test("measures sealed reasoning only in its original assignment and returns only a decision", () => {
  const binding = { userId: "user", scopeID: "scope", assignmentID: "one" }
  const redactor = createReasoningRedactor("test-key", binding)
  const reply = z.object({ choices: z.array(z.object({ message: z.unknown() })) }).parse(
    redactor.redact({
      choices: [{ message: { role: "assistant", content: "Done", reasoning: "Think carefully. ".repeat(50) } }],
    }),
  )
  const input = { completedUserTurns: 2, messages: [{ role: "user", content: "Do this" }, reply.choices[0]!.message] }
  expect(compactionPolicy(input, redactor.restore(input))).toEqual({ compact: true })
  const other = createReasoningRedactor("test-key", { ...binding, assignmentID: "two" })
  expect(compactionPolicy(input, other.restore(input))).toEqual({ compact: false })
})
