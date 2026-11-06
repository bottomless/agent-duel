import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/effect/websearch"
import { host } from "../../../core/test/plugin/host"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { closeStore } from "@/arena/runtime"
import { createArenaWebSearchPlugin } from "@/arena/websearch"

const originalFetch = globalThis.fetch

afterEach(async () => {
  await closeStore()
  setArenaCredentials(undefined)
  globalThis.fetch = originalFetch
})

function hosted() {
  setArenaCredentials({
    mode: "hosted",
    researchPartition: "test-research-partition",
    researchAccountID: "test-account",
    token: "test-session",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken("local-control-token"),
  })
}

/** Installs the plugin and returns what it registered. */
async function install(enabled = true) {
  const added: WebSearchDefinition[] = []
  let selection: string | false | undefined
  const editor: WebSearchEditor = {
    add: (definition) => added.push(definition),
    default: { get: () => selection, set: (value) => (selection = value) },
  }
  const context = host({
    websearch: {
      providers: () => Effect.die("unused"),
      query: () => Effect.die("unused"),
      reload: () => Effect.void,
      transform: (callback) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  })
  await Effect.runPromise(createArenaWebSearchPlugin({ enabled: () => enabled }).effect(context) as Effect.Effect<void>)
  return { added, selection: () => selection }
}

describe("Arena web search provider", () => {
  test("adds OpenRouter as the default, so the provider form never opens", async () => {
    const { added, selection } = await install()
    expect(added.map(({ id, name }) => ({ id, name }))).toEqual([{ id: "openrouter", name: "OpenRouter" }])
    expect(selection()).toBe("openrouter")
    const off = await install(false)
    expect(off.added).toEqual([])
    expect(off.selection()).toBeUndefined()
  })

  test("searches on the control plane with the session and returns the results", async () => {
    hosted()
    const requests: { url: string; authorization: string | null; body: unknown }[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init)
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: JSON.parse(await request.text()),
        })
        return Response.json({
          results: [{ url: "https://docs.expo.dev/", title: "Expo", content: "SDK 58" }, { title: "no url" }],
        })
      },
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    )
    const { added } = await install()
    const results = await Effect.runPromise(added[0].execute({ query: ` ${"x".repeat(500)} ` }))
    expect(requests).toEqual([
      {
        url: "https://control.test/api/arena/websearch",
        authorization: "Bearer test-session",
        body: { query: "x".repeat(400) },
      },
    ])
    expect(results).toEqual([{ url: "https://docs.expo.dev/", title: "Expo", content: "SDK 58", time: {} }])
  })

  test("fails the search with the rate limit message on 429", async () => {
    hosted()
    globalThis.fetch = Object.assign(async () => Response.json({ error: "Too many" }, { status: 429 }), {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    })
    const { added } = await install()
    const failure = await Effect.runPromise(Effect.flip(added[0].execute({ query: "x" })))
    expect(String(failure)).toContain("Web search rate limited (HTTP 429)")
  })
})
