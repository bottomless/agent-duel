import { describe, expect, test } from "bun:test"
import { resolveBuildCommit, resolveBuildMetadata } from "@/arena/provenance"
import { version as opencodeVersion } from "../../package.json"
import { version as agentDuelVersion } from "../../../../../package.json"

describe("ArenaProvenance", () => {
  test("separates the OpenCode version from the Agent Duel version and source build", async () => {
    expect(await resolveBuildMetadata({ OPENCODE_ARENA_BUILD_SHA: "ABCDEF1234567" })).toEqual({
      opencodeVersion,
      agentDuelVersion,
      agentDuelBuildNumber: 0,
      agentDuelCommit: "abcdef1234567",
    })
  })

  test("prefers an explicit pinned build SHA", async () => {
    let detected = false
    const commit = await resolveBuildCommit({ OPENCODE_ARENA_BUILD_SHA: "ABCDEF1234567" }, async () => {
      detected = true
      return undefined
    })

    expect(commit).toBe("abcdef1234567")
    expect(detected).toBe(false)
  })

  test("detects a source checkout and rejects missing or invalid provenance", async () => {
    await expect(resolveBuildCommit({}, async () => "1234567890abcdef1234567890abcdef12345678")).resolves.toBe(
      "1234567890abcdef1234567890abcdef12345678",
    )
    await expect(resolveBuildCommit({ OPENCODE_ARENA_BUILD_SHA: "not-a-sha" }, async () => undefined)).rejects.toThrow(
      "must be a Git commit SHA",
    )
    await expect(resolveBuildCommit({}, async () => undefined)).rejects.toThrow("build provenance is unavailable")
  })
})
