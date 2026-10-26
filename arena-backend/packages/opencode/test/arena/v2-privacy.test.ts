import { describe, expect, test } from "bun:test"
import { REDACTED_THINKING } from "@agent-duel/arena-service/reasoning"
import { sanitizeV2 } from "@/arena/v2-privacy"

describe("sanitizeV2", () => {
  test("keeps native assistant and tool shapes while hiding provider replay data", () => {
    const value = sanitizeV2({
      type: "message.updated",
      data: {
        info: {
          role: "assistant",
          model: { id: "gpt-5-secret", providerID: "vendor-secret", variant: "fast" },
          cost: 12.3,
          tokens: { input: 20, output: 10 },
          providerState: { raw: "provider replay" },
          content: [
            { type: "reasoning", text: "private chain of thought", state: { raw: "secret" } },
            { type: "text", text: "ordinary assistant prose" },
            {
              type: "tool",
              id: "provider-call-id",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "echo hello" },
                content: [{ type: "text", text: "hello" }],
                providerState: { raw: "secret" },
                metadata: { provider: "vendor-secret", title: "Shell" },
              },
            },
          ],
        },
      },
      models: [{ id: "gpt-5-secret", providerID: "vendor-secret" }],
      providers: [{ id: "vendor-secret" }],
    }) as any

    const encoded = JSON.stringify(value)
    expect(encoded).not.toContain("gpt-5-secret")
    expect(encoded).not.toContain("vendor-secret")
    expect(encoded).not.toContain("provider replay")
    expect(encoded).not.toContain("private chain of thought")
    expect(value.data.info.cost).toBe(0)
    expect(value.data.info.tokens).toEqual({ input: 0, output: 0 })
    expect(value.models).toBeUndefined()
    expect(value.providers).toBeUndefined()
    expect(value.data.info.model).toEqual({ id: "contestant", providerID: "arena", variant: "fast" })
    expect(value.data.info.content[0]).toMatchObject({ type: "reasoning", text: REDACTED_THINKING })
    expect(value.data.info.content[1]).toEqual({ type: "text", text: "ordinary assistant prose" })
    expect(value.data.info.content[2].state.input).toEqual({ command: "echo hello" })
    expect(value.data.info.content[2].state.content).toEqual([{ type: "text", text: "hello" }])
    expect(value.data.info.content[2].id).toMatch(/^call_arena_/)

    const catalogEntry = sanitizeV2({
      model: {
        id: "medium",
        modelID: "medium",
        providerID: "vendor-secret",
        name: "Vendor Secret Model",
        family: "vendor-family",
        package: "vendor-package",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
      },
      providerInfo: { id: "vendor-secret", name: "Vendor Secret", activation: "auto", package: "vendor-package" },
    }) as any
    expect(catalogEntry.model).toMatchObject({
      id: "medium",
      modelID: "medium",
      providerID: "arena",
      name: "Arena model",
      family: "arena",
      package: "",
    })
    expect(catalogEntry.providerInfo).toMatchObject({ id: "arena", name: "Arena", package: "" })
    expect(JSON.stringify(catalogEntry)).not.toContain("vendor-secret")
    expect(JSON.stringify(catalogEntry)).not.toContain("vendor-package")
  })

  test("sanitizes streaming envelopes without changing event order or safe errors", () => {
    const value = sanitizeV2([
      { type: "session.text.delta", data: { delta: "hello", sequence: 1 } },
      { type: "session.text.delta", data: { delta: " world", sequence: 2 } },
      { type: "session.step.failed", data: { error: "vendor-secret payment quota exhausted" } },
      { type: "session.status", data: { status: { type: "idle" } } },
    ]) as any
    expect(value.map((event: any) => event.type)).toEqual([
      "session.text.delta",
      "session.text.delta",
      "session.step.failed",
      "session.status",
    ])
    expect(value[0].data.delta).toBe("hello")
    expect(value[1].data.delta).toBe(" world")
    expect(value[2].data.error).toBe("The agent could not complete this run.")

    const structured = sanitizeV2({
      error: {
        name: "APIError",
        data: { message: "vendor-secret failed", statusCode: 503, responseBody: "raw vendor replay" },
      },
    }) as any
    expect(structured.error).toEqual({
      name: "APIError",
      data: { message: "The agent could not complete this run.", statusCode: 503 },
      message: "The agent could not complete this run.",
    })
    expect(JSON.stringify(structured)).not.toContain("vendor-secret")
    expect(JSON.stringify(structured)).not.toContain("raw vendor replay")
  })

  test("redacts native reasoning and session errors while preserving event shapes", () => {
    const value = sanitizeV2([
      { type: "session.reasoning.delta", data: { delta: "private reasoning", ordinal: 0 } },
      { type: "session.reasoning.ended", data: { text: "private conclusion", ordinal: 0 } },
      { type: "session.text.delta", data: { delta: "ordinary prose" } },
      {
        type: "session.error",
        data: {
          error: {
            name: "APIError",
            data: { message: "vendor failure", statusCode: 503, responseBody: "private replay" },
          },
        },
      },
    ]) as Array<{
      type: string
      data: Record<string, unknown>
    }>

    expect(value[0]).toEqual({
      type: "session.reasoning.delta",
      data: { delta: REDACTED_THINKING, ordinal: 0 },
    })
    expect(value[1]).toEqual({
      type: "session.reasoning.ended",
      data: { text: REDACTED_THINKING, ordinal: 0 },
    })
    expect(value[2]).toEqual({ type: "session.text.delta", data: { delta: "ordinary prose" } })
    expect(value[3].data.error).toEqual({
      name: "APIError",
      data: { message: "The agent could not complete this run.", statusCode: 503 },
      message: "The agent could not complete this run.",
    })
    const encoded = JSON.stringify(value)
    expect(encoded).not.toContain("private reasoning")
    expect(encoded).not.toContain("private conclusion")
    expect(encoded).not.toContain("vendor failure")
    expect(encoded).not.toContain("private replay")
  })
})
