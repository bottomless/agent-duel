import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Flock } from "@opencode-ai/core/util/flock"
import { Effect, Layer } from "effect"
import { ArenaModelProfile } from "@/arena/model-profile"
import { Provider } from "@/provider/provider"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const arenaMode = process.env.OPENCODE_ARENA
afterEach(() => {
  if (arenaMode === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = arenaMode
})

// Fail at the catalog boundary so a hidden dependency fails immediately instead of hanging the test.
const unavailableCatalog = Layer.mock(ModelsDev.Service, {
  get: () => Effect.die(new Error("Catalog is unavailable")),
})
const it = testEffect(LayerNode.compile(Provider.node, [[ModelsDev.node, unavailableCatalog]]))

it.instance("Arena resolves startup metadata and both contestant models without the external catalog", () =>
  Effect.gen(function* () {
    process.env.OPENCODE_ARENA = "1"
    const provider = yield* Provider.Service
    const providers = yield* provider.list()
    expect(Object.keys(providers)).toEqual(["arena"])

    const bootstrap = yield* provider.getModel(
      ProviderV2.ID.openrouter,
      ModelV2.ID.make(ArenaModelProfile.bootstrapModel.modelID),
    )
    expect(bootstrap.name).toBe(ArenaModelProfile.bootstrapModel.displayName)
    expect(bootstrap.options.provider).toEqual(ArenaModelProfile.bootstrapModel.routing)

    for (const profile of [ArenaModelProfile.contestant, ArenaModelProfile.medium]) {
      const model = yield* provider.getModel(ProviderV2.ID.make("arena"), ModelV2.ID.make(profile.id))
      expect(model.limit).toEqual({ context: profile.contextWindow, output: profile.outputLimit })
      const language = yield* provider.getLanguage(model)
      expect(language.modelId).toBe(profile.id)
    }
  }),
)

it.instance("ordinary OpenCode still reports an unavailable catalog", () =>
  Effect.gen(function* () {
    process.env.OPENCODE_ARENA = "0"
    const provider = yield* Provider.Service
    const result = yield* provider.list().pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }),
)

test("Arena serves discovery and creates a session while another process holds the catalog lock", async () => {
  await using directory = await tmpdir()
  const home = path.join(directory.path, "home")
  await mkdir(home)
  const cache = path.join(directory.path, "cache")
  const state = path.join(directory.path, "state")
  await using _lock = await Flock.acquire(`models-dev:${path.join(cache, "opencode", "models.json")}`, {
    dir: path.join(state, "opencode", "locks"),
  })
  const controlToken = "catalog-lock-regression"
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--conditions=browser",
      "src/index.ts",
      "--arena-credentials-stdin",
      "--port",
      "0",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: path.join(directory.path, "config"),
        XDG_CACHE_HOME: cache,
        XDG_DATA_HOME: path.join(directory.path, "data"),
        XDG_STATE_HOME: state,
        OPENCODE_TEST_HOME: home,
        PASEO_HOME: path.join(directory.path, "paseo"),
        OPENCODE_AUTH_CONTENT: "{}",
      },
      stdin: new Response(
        JSON.stringify({
          mode: "hosted",
          token: "test-runtime-token",
          controlPlaneUrl: "http://127.0.0.1:1",
          researchPartition: "test-research-partition",
          researchAccountID: "test-account",
          controlTokenHash: createHash("sha256").update(controlToken).digest("hex"),
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let url: string | undefined
    while (!url) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Engine exited before listening: ${output}`)
      output += decoder.decode(chunk.value, { stream: true })
      url = /listening on (http:\/\/\S+)/.exec(output)?.[1]
    }
    reader.releaseLock()
    const headers = { "x-paseo-control-token": controlToken, "x-opencode-directory": home }
    const providers = await fetch(new URL("/provider", url), { headers, signal: AbortSignal.timeout(3_000) })
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual({ all: [], default: {}, connected: [] })
    const modes = await fetch(new URL("/agent", url), { headers, signal: AbortSignal.timeout(3_000) })
    expect(modes.status).toBe(200)
    const session = await fetch(new URL("/session", url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ id: expect.stringMatching(/^ses_/) })
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
  } finally {
    clearTimeout(deadline)
    child.kill("SIGKILL")
    await child.exited
  }
}, 20_000)
