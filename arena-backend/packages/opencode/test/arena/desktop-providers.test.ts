import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { desktopProviders } from "../../script/desktop-providers"

const engine = path.resolve(import.meta.dirname, "../..")
const dynamic = path.resolve(engine, "../core/src/plugin/provider/dynamic.ts")
const effect = Bun.resolveSync("effect", engine)
const npm = path.resolve(engine, "../util/src/npm.ts")
const models = path.join(engine, "src/arena/engine-runtime/models.ts")

test("compiled Arena initializes every routed provider without npm, network, or checkout modules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-desktop-providers-"))
  try {
    const entry = path.join(directory, "probe.js")
    const outfile = path.join(directory, process.platform === "win32" ? "probe.exe" : "probe")
    await Bun.write(
      entry,
      `
import { Effect } from ${JSON.stringify(effect)}
import { Npm } from ${JSON.stringify(npm)}
import { DynamicProviderPlugin } from ${JSON.stringify(dynamic)}
import { models } from ${JSON.stringify(models)}
import { pathToFileURL } from "node:url"
const denied = () => Effect.die(new Error("npm must not run"))
const npm = Npm.Service.of({ add: denied, resolve: denied, check: denied, update: denied, which: denied })
globalThis.fetch = () => { throw new Error("network must not run") }
await Effect.runPromise(Effect.gen(function* () {
  let hook
  yield* DynamicProviderPlugin.effect({ aisdk: { hook: (_, callback) => {
    hook = callback
    return Effect.succeed({ dispose: Effect.void })
  } } })
  const loaded = []
  for (const model of models) {
    const event = { model, package: model.package.replace(/^aisdk:/, ""), options: { apiKey: "local-probe" } }
    yield* hook(event)
    const language = event.sdk.languageModel(model.modelID)
    if (language.specificationVersion !== "v3" || language.modelId !== model.modelID)
      throw new Error("Bundled SDK did not initialize " + model.id)
    loaded.push(model.id)
  }
  const unknown = { model: models[0], package: "@arena/not-bundled", options: {} }
  const exit = yield* hook(unknown).pipe(Effect.exit)
  if (exit._tag !== "Failure" || !String(exit.cause).includes("Arena provider is not bundled"))
    throw new Error("Unknown Arena providers must fail without npm")
  const sdk = { existing: true }
  const existing = { model: models[0], package: "@arena/not-bundled", options: {}, sdk }
  yield* hook(existing)
  if (existing.sdk !== sdk) throw new Error("An earlier SDK was overwritten")
  // The inherited file-provider route must still reach Core's original loader.
  const other = {
    model: { ...models[0], providerID: "custom" },
    package: pathToFileURL(process.cwd() + "/custom.mjs").href,
    options: { marker: "unchanged" },
  }
  yield* hook(other)
  if (other.sdk.marker !== "unchanged") throw new Error("Non-Arena provider loading changed")
  console.log(JSON.stringify(loaded))
}).pipe(Effect.provideService(Npm.Service, npm)))
`,
    )
    const providers = desktopProviders()
    const result = await Bun.build({
      entrypoints: [entry],
      conditions: ["browser"],
      plugins: [providers.plugin],
      compile: { outfile },
    })
    expect(result.success).toBe(true)
    providers.check()
    await rm(entry)
    await Bun.write(
      path.join(directory, "custom.mjs"),
      "export function createFixture(options) { return { marker: options.marker } }",
    )
    // cwd and the executable have no node_modules. The executable never starts a server or battle.
    const child = Bun.spawn([outfile], { cwd: directory, env: { PATH: "" }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual(["contestant", "medium"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("desktop build rejects an externalized Arena provider", async () => {
  const providers = desktopProviders()
  const result = await Bun.build({
    entrypoints: [dynamic],
    target: "bun",
    plugins: [providers.plugin],
    external: [Bun.resolveSync("@openrouter/ai-sdk-provider", engine)],
  })
  expect(result.success).toBe(true)
  expect(() => providers.check()).toThrow("Desktop bundle is missing Arena provider @openrouter/ai-sdk-provider")
})

test("desktop build rejects a bundle that never installs the provider hook", async () => {
  const providers = desktopProviders()
  const result = await Bun.build({ entrypoints: [models], target: "bun", plugins: [providers.plugin] })
  expect(result.success).toBe(true)
  expect(() => providers.check()).toThrow("Desktop provider hook replaced 0 modules, expected 1")
})
