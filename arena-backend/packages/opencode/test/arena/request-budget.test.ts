import { expect, test } from "bun:test"
import { ArenaRequestBudget } from "@/arena/request-budget"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Schema } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"

const cfg = Schema.decodeUnknownSync(ConfigV1.Info)({})

function model(context: number, output: number): Provider.Model {
  return ProviderTest.model({
    providerID: ProviderV2.ID.make("arena"),
    id: ProviderV2.ID.make("contestant"),
    limit: { context, output },
  })
}

test("keeps the public request ceiling for a model with a larger context window", () => {
  expect(
    ArenaRequestBudget.inputLimit({
      cfg,
      model: model(500_000, 32_768),
      outputTokenMax: 32_768,
    }),
  ).toBe(272_000)
})

test("uses the assigned model budget below the public request ceiling", () => {
  expect(
    ArenaRequestBudget.inputLimit({
      cfg,
      model: model(65_536, 32_768),
      outputTokenMax: 32_768,
    }),
  ).toBe(32_768)
})

test("checks an explicit budget at both sides of the estimate boundary", () => {
  const request: LanguageModelV3CallOptions = {
    prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(4_000) }] }],
  }
  const estimate = ArenaRequestBudget.estimate(request)
  expect(ArenaRequestBudget.exceeds(request, estimate - 1)).toBe(true)
  expect(ArenaRequestBudget.exceeds(request, estimate + 1)).toBe(false)
  expect(() => ArenaRequestBudget.check(request, estimate)).toThrow(ArenaRequestBudget.CompactionRequired)
})

test("includes system instructions and tool schemas before accepting an Arena request", () => {
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(260_000 * 4) }] }]
  expect(ArenaRequestBudget.exceeds({ prompt })).toBe(false)
  expect(
    ArenaRequestBudget.exceeds({
      prompt: [{ role: "system", content: "s".repeat(8_000 * 4) }, ...prompt],
      tools: [{ type: "function", name: "read", description: "d".repeat(8_000 * 4), inputSchema: { type: "object" } }],
    }),
  ).toBe(true)
})

test("counts the newest user message when requesting compaction", () => {
  const request: LanguageModelV3CallOptions = {
    prompt: [
      { role: "user", content: [{ type: "text", text: "history".repeat(140_000) }] },
      { role: "assistant", content: [{ type: "text", text: "Finished the previous step." }] },
      { role: "user", content: [{ type: "text", text: "new request".repeat(20_000) }] },
    ],
  }
  expect(ArenaRequestBudget.exceeds({ prompt: request.prompt.slice(0, 2) })).toBe(false)
  expect(() => ArenaRequestBudget.check(request)).toThrow(ArenaRequestBudget.CompactionRequired)
})

test("bounds user and tool-result media without counting encoded bytes or mutating the request", () => {
  function request(data: string): LanguageModelV3CallOptions {
    return {
      prompt: [
        { role: "user", content: [{ type: "file", data, mediaType: "image/png" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "read",
              toolCallId: "call-1",
              output: { type: "content", value: [{ type: "image-data", data, mediaType: "image/png" }] },
            },
          ],
        },
      ],
    }
  }
  const large = request("A".repeat(2_000_000))
  const original = structuredClone(large)
  expect(ArenaRequestBudget.estimate(large)).toBe(ArenaRequestBudget.estimate(request("AA")))
  expect(ArenaRequestBudget.estimate(large)).toBeGreaterThan(8_000)
  expect(large).toEqual(original)
})
