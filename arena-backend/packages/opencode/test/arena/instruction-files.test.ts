import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

// Core's instruction-discovery tests cover what `claude: false` skips: the per-directory CLAUDE.md
// fallback and ~/.claude/CLAUDE.md. This pins that the engine asks for it.
describe("engine instruction files", () => {
  test("contestants read AGENTS.md, not a user's CLAUDE.md", () => {
    expect(Server.routeOptions({}).instructions?.claude).toBe(false)
  })

  test("an explicit option can still turn CLAUDE.md on", () => {
    expect(Server.routeOptions({ instructions: { claude: true } }).instructions?.claude).toBe(true)
  })
})
