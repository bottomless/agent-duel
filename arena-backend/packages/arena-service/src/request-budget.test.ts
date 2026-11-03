import { describe, expect, test } from "bun:test"
import { DEFAULT_COMPACT_AT, DEFAULT_MODEL_OUTPUT_LIMIT, modelLimits } from "./pool"
import { estimateRequest, prepareRequest } from "./request-budget"

describe("Arena request budget", () => {
  test("defaults output to the private runtime cap and keeps it below a small context", () => {
    expect(modelLimits({ contextWindow: 200_000 }).output).toBe(DEFAULT_MODEL_OUTPUT_LIMIT)
    expect(modelLimits({ contextWindow: 1000 }).output).toBe(250)
    expect(modelLimits({ contextWindow: 1_000_000, limits: { context: 65_536 } }).output).toBe(16_384)
    expect(() => modelLimits({ contextWindow: 0 })).toThrow()
    expect(() => modelLimits({ contextWindow: -1 })).toThrow()
  })

  test("compacts large windows at the savings level and small ones below their input room", () => {
    expect(modelLimits({ contextWindow: 1_000_000 }).compactAt).toBe(DEFAULT_COMPACT_AT)
    expect(modelLimits({ contextWindow: 500_000 }).compactAt).toBe(DEFAULT_COMPACT_AT)
    expect(modelLimits({ contextWindow: 1_000_000, limits: { context: 65_536 } })).toEqual({
      context: 65_536,
      output: 16_384,
      compactAt: 41_779,
    })
    expect(modelLimits({ contextWindow: 128_000, limits: { output: 32_000 } }).compactAt).toBe(81_600)
    expect(modelLimits({ contextWindow: 128_000, limits: { compactAt: 50_000 } }).compactAt).toBe(50_000)
  })

  test("validates private endpoint overrides", () => {
    expect(() => modelLimits({ contextWindow: 1000, limits: { context: 2000 } })).toThrow()
    expect(() => modelLimits({ contextWindow: 1000, limits: { output: 1000 } })).toThrow()
    expect(() => modelLimits({ contextWindow: 1000, limits: { output: 0 } })).toThrow()
    expect(() => modelLimits({ contextWindow: 1000, limits: { output: 200, compactAt: 900 } })).toThrow()
    expect(() => modelLimits({ contextWindow: 1000, limits: { compactAt: 0 } })).toThrow()
  })

  test("counts full request fields while omitting encoded media bytes", () => {
    const short = {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "AA" } }] }],
      instructions: "system instructions",
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      response_format: { type: "json_schema", json_schema: { name: "answer" } },
    }
    const large = structuredClone(short)
    large.messages[0]!.content[0]!.image_url.url = "A".repeat(2_000_000)
    expect(estimateRequest(large)).toBe(estimateRequest(short))
    expect(estimateRequest(short)).toBeGreaterThan(4000)
  })

  test("preserves tool schemas while bounding media in message content", () => {
    const schema = "A".repeat(200_000)
    const withSchema = {
      messages: [{ role: "user", content: [{ type: "text", text: "read" }] }],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { properties: { image_url: { description: schema } } } },
        },
      ],
    }
    const withMedia = {
      ...withSchema,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "A".repeat(2_000_000) } }] }],
    }
    expect(estimateRequest(withSchema)).toBeGreaterThan(50_000)
    expect(estimateRequest(withMedia)).toBeGreaterThan(estimateRequest(withSchema))
  })

  test.each([undefined, "message"])("bounds media nested in a Responses message wrapper with type %s", (type) => {
    const request = (image: string, file: string) => ({
      input: [
        {
          type,
          role: "user",
          content: [
            { type: "input_image", image_url: image },
            { type: "input_file", file_data: file },
          ],
        },
      ],
    })
    expect(estimateRequest(request("AA", "BB"))).toBe(
      estimateRequest(request("A".repeat(2_000_000), "B".repeat(2_000_000))),
    )
  })

  test("clamps output and supports chat and Responses request fields", () => {
    const limits = { context: 100_000, output: 500 }
    const chat = prepareRequest({ messages: [], max_tokens: 5000 }, "chat", limits)
    expect(chat.request.max_tokens).toBe(500)
    expect(chat.output).toBe(500)
    const responses = prepareRequest({ input: [], max_output_tokens: 5000 }, "responses", limits)
    expect(responses.request.max_output_tokens).toBe(500)
    expect(responses.output).toBe(500)
  })
})
