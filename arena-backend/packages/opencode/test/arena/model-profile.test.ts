import { describe, expect, test } from "bun:test"
import { ArenaModelProfile } from "@/arena/model-profile"

describe("ArenaModelProfile", () => {
  test("ships one model-neutral contestant capability envelope", () => {
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
})
