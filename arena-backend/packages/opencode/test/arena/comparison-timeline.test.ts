import { describe, expect, test } from "bun:test"
import { comparisonTimeline, showedOutput } from "@/arena/comparison-timeline"

describe("Arena comparison timeline", () => {
  test("keeps only post-prompt visible text and tool name/status", () => {
    const result = comparisonTimeline(
      [
        { info: { id: "msg_100", role: "assistant" }, parts: [{ type: "text", text: "old history" }] },
        { info: { id: "msg_200", role: "user" }, parts: [{ type: "text", text: "current prompt" }] },
        {
          info: { id: "msg_300", role: "assistant", modelID: "hidden-model" },
          parts: [
            { type: "reasoning", text: "I will inspect the code" },
            {
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { path: "secret.ts" }, output: "full tool output" },
            },
            { type: "text", text: "Implemented the change" },
          ],
        },
      ],
      "msg_200",
      new Set(["hidden-model"]),
    )

    expect(result).not.toContain("old history")
    expect(result).not.toContain("current prompt")
    expect(result).not.toContain("hidden-model")
    expect(result).not.toContain("secret.ts")
    expect(result).not.toContain("full tool output")
    expect(result).not.toContain("I will inspect the code")
    expect(JSON.parse(result)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool", name: "read", status: "completed" },
          { type: "narrative", text: "Implemented the change" },
        ],
      },
    ])
  })

  test("drops tool calls the runtime swept without executing", () => {
    const result = comparisonTimeline(
      [
        {
          info: { id: "msg_300", role: "assistant" },
          parts: [
            { type: "tool", tool: "edit", state: { status: "completed" } },
            {
              type: "tool",
              tool: "unknown",
              state: { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } },
            },
          ],
        },
      ],
      "msg_200",
      new Set(),
    )

    expect(result).not.toContain("unknown")
    expect(JSON.parse(result)).toEqual([
      { role: "assistant", content: [{ type: "tool", name: "edit", status: "completed" }] },
    ])
  })

  test("fails closed without a durable prompt boundary", () => {
    expect(comparisonTimeline([{ info: { id: "msg_1", role: "assistant" }, parts: [] }], undefined, new Set())).toBe(
      "[]",
    )
  })

  test("counts what a side showed after its prompt, reasoning included", () => {
    const history = [
      { info: { id: "msg_100", role: "assistant" }, parts: [{ type: "text", text: "earlier turn" }] },
      { info: { id: "msg_200", role: "user" }, parts: [{ type: "text", text: "current prompt" }] },
    ]
    const answered = (parts: unknown[]) => [...history, { info: { id: "msg_300", role: "assistant" }, parts }]

    // A request that failed before any output leaves an assistant message with nothing in it.
    expect(showedOutput(answered([{ type: "step-start" }]), "msg_200")).toBe(false)
    expect(showedOutput(answered([{ type: "text", text: "  " }]), "msg_200")).toBe(false)
    expect(showedOutput(history, "msg_200")).toBe(false)
    expect(showedOutput(answered([{ type: "text", text: "Done." }]), "msg_200")).toBe(true)
    expect(showedOutput(answered([{ type: "reasoning", text: "Thinking it over" }]), "msg_200")).toBe(true)
    expect(showedOutput(answered([{ type: "tool", tool: "read", state: { status: "error" } }]), "msg_200")).toBe(true)
  })
})
