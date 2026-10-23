import { describe, expect, test } from "bun:test"
import { ArenaModelProfile } from "@/arena/model-profile"
import { ProviderTest } from "../fake/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { isOverflow, usable } from "@/session/overflow"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Schema } from "effect"

describe("ArenaModelProfile", () => {
  test("ships model-neutral startup metadata before assignment", () => {
    expect(ArenaModelProfile.contestant).toEqual({
      id: "contestant",
      contextWindow: 500_000,
      outputLimit: 131_072,
    })
    expect(ArenaModelProfile.highReasoning).toEqual({ variant: "high", reasoning: { effort: "high" } })
    const serialized = JSON.stringify(ArenaModelProfile.contestant)
    expect(serialized).not.toContain("glm")
    expect(serialized).not.toContain("qwen")
    expect(serialized).not.toContain("grok")
  })

  test("uses negotiated limits for output reservation and compacts before a 65k window fills", () => {
    const original = ProviderTest.model({
      providerID: ProviderV2.ID.make("arena"),
      limit: { context: 500_000, output: 131_072 },
    })
    const narrow = ArenaModelProfile.withLimits(original, { context: 65_536, output: 32_768 })
    const cfg = Schema.decodeUnknownSync(ConfigV1.Info)({})
    expect(narrow.limit).toEqual({ context: 65_536, output: 32_768 })
    expect(original.limit).toEqual({ context: 500_000, output: 131_072 })
    expect(usable({ cfg, model: narrow, outputTokenMax: 32_768 })).toBe(32_768)
    const tokens = { input: 32_768, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(isOverflow({ cfg, tokens, model: narrow, outputTokenMax: 32_768 })).toBe(true)
    expect(isOverflow({ cfg, tokens: { ...tokens, input: 32_767 }, model: narrow, outputTokenMax: 32_768 })).toBe(false)
    expect(isOverflow({ cfg, tokens, model: original, outputTokenMax: 32_768 })).toBe(false)
  })
})
