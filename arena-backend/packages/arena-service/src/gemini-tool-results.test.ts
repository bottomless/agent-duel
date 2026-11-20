import { describe, expect, test } from "bun:test"
import { geminiToolResultRetry } from "./gemini-tool-results"

const providerError = {
  error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
}
const errorBody = {
  error: { code: 400, metadata: { provider_name: "Google AI Studio", raw: JSON.stringify(providerError) } },
}
const model = "google/gemini-4-carbon"

describe("Gemini tool-result retry", () => {
  test("changes only plain text in the pending parallel tool-result batch, without mutating input", async () => {
    const history = [
      { role: "tool", tool_call_id: "old-call", content: "Earlier output" },
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
        reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", id: "call-1" }],
      },
    ]
    const untouched = [
      { role: "tool", tool_call_id: "json", content: '{"rows":[1,2]}' },
      { role: "tool", tool_call_id: "array", content: "[1,2]" },
      { role: "tool", tool_call_id: "number", content: "123" },
      { role: "tool", tool_call_id: "null", content: "null" },
      { role: "tool", tool_call_id: "boolean", content: "false" },
      { role: "tool", tool_call_id: "string", content: '"hello"' },
      { role: "tool", tool_call_id: "blank", content: "  " },
      { role: "tool", tool_call_id: "empty", content: "" },
      {
        role: "tool",
        tool_call_id: "blocks",
        content: [
          { type: "text", text: "error" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
    ]
    const tool = { role: "tool", tool_call_id: "call-1", name: "read", content: 'Line 1\r\n日本語 "quoted" \\ path' }
    const input = {
      model,
      messages: [...history, tool, ...untouched],
      tools: [{ type: "function", function: { name: "read" } }],
      provider: { only: ["google-ai-studio"] },
      max_tokens: 32_000,
    }
    const snapshot = structuredClone(input)
    const response = Response.json(errorBody, { status: 400 })
    const retry = await geminiToolResultRetry(input, response)
    expect(retry?.request).toEqual({
      ...input,
      messages: [...history, { ...tool, content: JSON.stringify({ output: tool.content }) }, ...untouched],
    })
    expect(input).toEqual(snapshot)
    expect(await response.json()).toEqual(errorBody)
    // The transformed batch is already JSON, so it cannot be wrapped a second time.
    expect(await geminiToolResultRetry(retry!.request, Response.json(errorBody, { status: 400 }))).toBeUndefined()
  })

  test.each([
    { label: "success", status: 200, body: errorBody, model },
    { label: "rate limit", status: 429, body: errorBody, model },
    { label: "server failure", status: 500, body: errorBody, model },
    { label: "other model", status: 400, body: errorBody, model: "anthropic/claude-sonnet-4.5" },
    { label: "untested Gemini", status: 400, body: errorBody, model: "google/gemini-4-neon" },
    {
      label: "other provider",
      status: 400,
      body: { error: { code: 400, metadata: { ...errorBody.error.metadata, provider_name: "Google Vertex" } } },
      model,
    },
    { label: "other error code", status: 400, body: { error: { ...errorBody.error, code: 429 } }, model },
    { label: "missing metadata", status: 400, body: { error: { code: 400 } }, model },
    {
      label: "invalid metadata JSON",
      status: 400,
      body: { error: { code: 400, metadata: { ...errorBody.error.metadata, raw: "not JSON" } } },
      model,
    },
    {
      label: "context overflow",
      status: 400,
      body: {
        error: {
          code: 400,
          metadata: {
            ...errorBody.error.metadata,
            raw: JSON.stringify({ error: { ...providerError.error, message: "Input exceeds context length" } }),
          },
        },
      },
      model,
    },
    {
      label: "missing signature",
      status: 400,
      body: {
        error: {
          code: 400,
          metadata: {
            ...errorBody.error.metadata,
            raw: JSON.stringify({
              error: { ...providerError.error, message: "Function call is missing a thought_signature" },
            }),
          },
        },
      },
      model,
    },
  ])("does not change handling of $label", async ({ status, body, model }) => {
    const response = Response.json(body, { status })
    expect(
      await geminiToolResultRetry({ model, messages: [{ role: "tool", content: "output" }] }, response),
    ).toBeUndefined()
    expect(await response.json()).toEqual(body)
  })

  test.each([
    [{ role: "user", content: "hello" }],
    [
      { role: "tool", content: "earlier output" },
      { role: "user", content: "continue" },
    ],
    [{ role: "tool", content: '{"output":"already JSON"}' }],
    [{ role: "tool", content: [{ type: "text", text: "error" }] }],
  ])("does not retry when the final batch has no eligible text: %j", async (...messages) => {
    expect(await geminiToolResultRetry({ model, messages }, Response.json(errorBody, { status: 400 }))).toBeUndefined()
  })
})
