import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

// Core's instruction-discovery tests cover what `claude` changes: the per-directory CLAUDE.md
// fallback and ~/.claude/CLAUDE.md. With imports the user's switches decide whether those load
// (`config/imported-setup.ts` in core); this pins that the engine never asks for them otherwise.
describe("engine instruction files", () => {
  const imported = process.env.AGENT_DUEL_IMPORTED_CONFIG
  afterEach(() => {
    if (imported === undefined) delete process.env.AGENT_DUEL_IMPORTED_CONFIG
    else process.env.AGENT_DUEL_IMPORTED_CONFIG = imported
  })

  test("without imports contestants read AGENTS.md, not a user's CLAUDE.md", () => {
    delete process.env.AGENT_DUEL_IMPORTED_CONFIG
    expect(Server.routeOptions({}).instructions?.claude).toBe(false)
  })

  test("with imports CLAUDE.md is offered and the switches decide", () => {
    process.env.AGENT_DUEL_IMPORTED_CONFIG = "/tmp/agent-plugins/opencode"
    expect(Server.routeOptions({}).instructions?.claude).toBe(true)
  })

  test("an explicit option still wins", () => {
    process.env.AGENT_DUEL_IMPORTED_CONFIG = "/tmp/agent-plugins/opencode"
    expect(Server.routeOptions({ instructions: { claude: false } }).instructions?.claude).toBe(false)
  })
})
