import { afterEach, describe, expect, test } from "bun:test"
import {
  arenaCredentials,
  hashArenaControlToken,
  initializeArenaCredentials,
  setArenaCredentials,
  withoutArenaCredentials,
} from "../../src/arena/credentials"

afterEach(() => setArenaCredentials(undefined))

const controlTokenHash = hashArenaControlToken("local-control-token")

async function* chunks(text: string) {
  yield new TextEncoder().encode(text.slice(0, 12))
  yield new TextEncoder().encode(text.slice(12))
}

test("receives the account credential without installing it in the process environment", async () => {
  const before = JSON.stringify(process.env)
  await initializeArenaCredentials(
    chunks(
      JSON.stringify({
        mode: "hosted",
        token: "test-session",
        controlPlaneUrl: "https://control.test/",
        controlTokenHash,
      }),
    ),
  )
  expect(arenaCredentials()).toEqual({
    mode: "hosted",
    token: "test-session",
    controlPlaneUrl: "https://control.test",
    controlTokenHash,
  })
  expect(JSON.stringify(arenaCredentials())).not.toContain("local-control-token")
  expect(JSON.stringify(process.env) === before).toBe(true)
})

test("receives the user's OpenRouter key without installing it in the process environment", async () => {
  const before = JSON.stringify(process.env)
  await initializeArenaCredentials(
    chunks(JSON.stringify({ mode: "byok", openRouterApiKey: " sk-or-v1-user-key\n", controlTokenHash })),
  )
  expect(arenaCredentials()).toEqual({ mode: "byok", openRouterApiKey: "sk-or-v1-user-key", controlTokenHash })
  expect(JSON.stringify(process.env) === before).toBe(true)
  expect(JSON.stringify(process.env)).not.toContain("sk-or-v1-user-key")
})

const hosted = { mode: "hosted", token: "secret-input", controlPlaneUrl: "https://control.test", controlTokenHash }
const byok = { mode: "byok", openRouterApiKey: "sk-or-v1-secret-input", controlTokenHash }

test.each([
  "",
  "{",
  "{}",
  "[]",
  JSON.stringify({ token: "secret-input", controlPlaneUrl: "https://control.test", controlTokenHash }),
  JSON.stringify({ ...hosted, mode: "local" }),
  JSON.stringify({ ...hosted, controlPlaneUrl: "invalid" }),
  JSON.stringify({ ...hosted, controlPlaneUrl: "https://user:pass@control.test" }),
  JSON.stringify({ ...hosted, token: "" }),
  JSON.stringify({ ...hosted, controlTokenHash: "" }),
  JSON.stringify({ ...hosted, openRouterApiKey: "sk-or-v1-secret-input" }),
  JSON.stringify({ ...byok, openRouterApiKey: "  " }),
  JSON.stringify({ ...byok, openRouterApiKey: "sk-or-v1 secret" }),
  JSON.stringify({ ...byok, openRouterApiKey: 42 }),
  JSON.stringify({ ...byok, controlTokenHash: "0".repeat(63) }),
  JSON.stringify({ mode: "byok", openRouterApiKey: "sk-or-v1-secret-input" }),
  JSON.stringify({ ...byok, token: "secret-input", controlPlaneUrl: "https://control.test" }),
  " ".repeat(65_537),
])("rejects invalid startup data without retaining a previous credential", async (text) => {
  setArenaCredentials({
    mode: "hosted",
    token: "old-session",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken("old-control-token"),
  })
  async function* whole() {
    yield new TextEncoder().encode(text)
  }
  await expect(initializeArenaCredentials(whole())).rejects.toThrow("Arena startup credentials are missing or invalid")
  expect(arenaCredentials()).toBeUndefined()
})

describe("Arena contestant environment", () => {
  test("does not expose the account, provider, or OpenCode control credential", () => {
    expect(
      withoutArenaCredentials({
        OPENROUTER_API_KEY: "session-token",
        PASEO_ARENA_SESSION_TOKEN: "session-token",
        PASEO_OPENCODE_CONTROL_TOKEN: "local-control-token",
        PASEO_OPENROUTER_BASE_URL: "https://control.test/api/openrouter",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      PASEO_OPENROUTER_BASE_URL: "https://control.test/api/openrouter",
      PATH: "/usr/bin",
    })
  })
})
