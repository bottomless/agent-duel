import { expect, test } from "bun:test"
import { requestTokenEstimate } from "@/arena/engine-runtime"

test("sealed provider state does not count as prompt text", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "thought" },
      { type: "text", text: "answer" },
    ],
  }
  const state = { openrouter: { reasoning: "arena_reasoning_v1." + "x".repeat(1_300_000) } }
  const request = {
    messages: [
      {
        ...message,
        providerState: state,
        content: message.content.map((part) => ({ ...part, providerMetadata: state })),
      },
    ],
    providerOptions: state,
  }
  expect(requestTokenEstimate(request)).toBe(requestTokenEstimate({ messages: [message] }))
})

test("media keeps its allowance and tool JSON remains prompt content", () => {
  const estimate = requestTokenEstimate({
    messages: [{ role: "user", content: [{ type: "media", media: { data: "x".repeat(2_000_000) } }] }],
  })
  expect(estimate).toBeGreaterThanOrEqual(4_000)
  expect(estimate).toBeLessThan(4_100)
  const input = { providerState: "x".repeat(1_100_000), state: "ordinary user data" }
  expect(
    requestTokenEstimate({ messages: [{ role: "assistant", content: [{ type: "tool-call", input }] }] }),
  ).toBeGreaterThan(272_000)
})
