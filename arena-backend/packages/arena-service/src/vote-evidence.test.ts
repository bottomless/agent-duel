import { describe, expect, test } from "bun:test"
import { classifyVote, voteSourceRules, type VoteEvidence } from "./vote-evidence"

function matched(event: Extract<VoteEvidence, { activation: "trusted" }>["os"]): VoteEvidence {
  return { activation: "trusted", input: "pointer", os: event }
}

describe("vote evidence", () => {
  test("labels a vote without evidence as an API vote", () => {
    expect(classifyVote(null)).toEqual({ voteSource: "api", voteSourceRules })
  })

  test("labels unparseable evidence unknown and keeps none of it", () => {
    for (const evidence of [
      undefined,
      "native",
      { activation: "trusted" },
      { activation: "trusted", input: "pointer", os: { status: "matched" } },
    ]) {
      expect(classifyVote(evidence)).toEqual({ voteSource: "unknown", voteSourceRules })
    }
  })

  test("labels script-dispatched and unrecognized activations", () => {
    expect(classifyVote({ activation: "script" }).voteSource).toBe("synthetic")
    expect(classifyVote({ activation: "unrecognized" }).voteSource).toBe("unknown")
  })

  test("leaves trusted activations without a matching OS event unverified", () => {
    expect(classifyVote(matched({ status: "unmatched" })).voteSource).toBe("unverified")
    expect(classifyVote(matched({ status: "no-monitor" })).voteSource).toBe("unverified")
    expect(classifyVote(matched({ status: "unavailable" })).voteSource).toBe("unknown")
  })

  test("classifies macOS events by whether they name a posting process", () => {
    const sources = (["none", "present", "unavailable"] as const).map(
      (sourceProcess) =>
        classifyVote(
          matched({
            status: "matched",
            elapsedMs: 12,
            distance: 0,
            event: { platform: "darwin", sourceProcess },
          }),
        ).voteSource,
    )
    expect(sources).toEqual(["native", "injected", "unknown"])
  })

  test("classifies Windows events by origin only when the device fits the input", () => {
    function source(input: "pointer" | "keyboard", origin: string, device: string) {
      return classifyVote({
        activation: "trusted",
        input,
        os: {
          status: "matched",
          elapsedMs: 5,
          distance: input === "pointer" ? 1 : null,
          event: { platform: "win32", origin, device },
        },
      }).voteSource
    }
    expect(source("pointer", "hardware", "mouse")).toBe("native")
    expect(source("pointer", "hardware", "touchpad")).toBe("native")
    expect(source("keyboard", "hardware", "keyboard")).toBe("native")
    expect(source("pointer", "injected", "mouse")).toBe("injected")
    expect(source("keyboard", "system", "keyboard")).toBe("injected")
    expect(source("pointer", "unavailable", "mouse")).toBe("unknown")
    expect(source("pointer", "hardware", "keyboard")).toBe("unknown")
    expect(source("keyboard", "hardware", "mouse")).toBe("unknown")
  })

  test("returns the parsed evidence without fields it does not know", () => {
    const evidence = {
      activation: "trusted",
      input: "keyboard",
      os: {
        status: "matched",
        elapsedMs: 40,
        distance: null,
        event: { platform: "darwin", sourceProcess: "none", sourcePID: 0 },
      },
    }
    expect(classifyVote(evidence)).toEqual({
      voteSource: "native",
      voteSourceRules,
      voteEvidence: {
        activation: "trusted",
        input: "keyboard",
        os: { status: "matched", elapsedMs: 40, distance: null, event: { platform: "darwin", sourceProcess: "none" } },
      },
    })
  })
})
