import { expect, test } from "bun:test"
import { captureReply, turnsAfterReply } from "@/arena/engine-runtime/compaction-policy"

test("counts answered user turns, not tools, steers or synthetic wakeups", () => {
  expect(turnsAfterReply([{ type: "user" }, { type: "user" }, { type: "assistant", finish: "tool-calls" }])).toBe(1)
  expect(
    turnsAfterReply([
      { type: "user" },
      { type: "assistant", finish: "stop" },
      { type: "synthetic" },
      { type: "assistant", finish: "stop" },
      { type: "user" },
    ]),
  ).toBe(2)
  expect(turnsAfterReply([{ type: "compaction", status: "completed" }, { type: "user" }])).toBe(2)
  expect(turnsAfterReply([{ type: "user" }, { type: "assistant", finish: "length" }, { type: "user" }])).toBe(1)
})

function reply(events: unknown[]) {
  return events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n"
}

test("captures a fragmented blinded final reply while preserving the exact native stream", async () => {
  const source = reply([
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning: "[Thinking redacted]",
            reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-one" }],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: { content: "latest 🙂" }, finish_reason: "stop" }] },
    { choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-two" }] } }] },
  ])
  const bytes = new TextEncoder().encode(source)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
      controller.close()
    },
  })
  const captured = captureReply(new Response(body, { headers: { "content-type": "text/event-stream" } }))
  expect(captured.result()).toBeUndefined()
  expect(await captured.response.text()).toBe(source)
  expect(captured.result()).toEqual({
    role: "assistant",
    content: "latest 🙂",
    reasoning: "[Thinking redacted]",
    reasoning_details: [
      { type: "reasoning.encrypted", data: "opaque-one" },
      { type: "reasoning.encrypted", data: "opaque-two" },
    ],
  })
})

test("never treats failed, truncated or tool replies as settled turns", async () => {
  for (const events of [
    [{ choices: [{ delta: { content: "partial" } }] }],
    [{ choices: [{ delta: {}, finish_reason: "length" }] }],
    [{ choices: [{ delta: { tool_calls: [{ index: 0 }] }, finish_reason: "tool_calls" }] }],
    [{ choices: [{ delta: {}, finish_reason: "stop" }] }, { error: { message: "failed" } }],
  ]) {
    const captured = captureReply(new Response(reply(events), { headers: { "content-type": "text/event-stream" } }))
    await captured.response.text()
    expect(captured.result()).toBeUndefined()
  }
})
