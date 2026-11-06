import { describe, expect, test } from "bun:test"
import { hasFinalProviderUsage, parseProviderUsage } from "./usage"

describe("provider usage", () => {
  test("parses OpenRouter Responses usage without converting absent fields to zero", () => {
    expect(
      parseProviderUsage({
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            total_tokens: 19,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }),
    ).toMatchObject({ promptTokens: 12, completionTokens: 7, reasoningTokens: 3, totalTokens: 19 })
    expect(parseProviderUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } })).toMatchObject({
      completionTokens: 7,
      reasoningTokens: null,
    })
  })

  test("combines Anthropic message_start and message_delta usage", () => {
    expect(
      parseProviderUsage([
        { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 4 } } },
        { type: "message_delta", usage: { output_tokens: 9 } },
      ]),
    ).toMatchObject({ promptTokens: 20, completionTokens: 9, reasoningTokens: null, cacheReadTokens: 4 })
    expect(
      parseProviderUsage([
        {
          type: "message_start",
          message: { usage: { input_tokens: 20, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 } },
        },
        { type: "message_delta", usage: { output_tokens: 9 } },
      ])?.totalTokens,
    ).toBe(39)
  })

  test("does not retain provisional reasoning zero or finalize message_start alone", () => {
    const start = { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } }
    expect(hasFinalProviderUsage([start])).toBe(false)
    expect(parseProviderUsage([start])).toMatchObject({
      completionTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    })
    expect(parseProviderUsage([start, { type: "message_delta", usage: { output_tokens: 9 } }])).toMatchObject({
      completionTokens: 9,
      reasoningTokens: null,
      totalTokens: null,
    })
  })

  test("preserves genuine zero generated and reasoning totals", () => {
    expect(
      parseProviderUsage({ usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, reasoning_tokens: 0 } }),
    ).toMatchObject({
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1,
    })
  })

  test("uses Anthropic cache fields for non-stream totals", () => {
    expect(
      parseProviderUsage({
        type: "message",
        usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 },
      })?.totalTokens,
    ).toBe(39)
    expect(
      parseProviderUsage({
        input_tokens: 20,
        output_tokens: 9,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 6,
      })?.totalTokens,
    ).toBe(39)
  })

  test("distinguishes missing provider cost from an explicit zero", () => {
    expect(parseProviderUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })?.cost).toBeNull()
    expect(parseProviderUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })?.totalTokens).toBe(3)
    expect(parseProviderUsage({ usage: { prompt_tokens: 1 } })?.totalTokens).toBeNull()
    expect(parseProviderUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0 } })?.cost).toBe(0)
  })
})
