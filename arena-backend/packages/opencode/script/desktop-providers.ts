import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { BunPlugin } from "bun"
import { models, provider, PROVIDER_ID } from "../src/arena/engine-runtime/models"

const factories = new Map([["@openrouter/ai-sdk-provider", "createOpenRouter"]])

// Core's dynamic hook runs before the host's Arena hook. Even though the latter imports the SDK,
// the former would first install an unversioned package through npm. Only the desktop Arena route
// bypasses that fallback; other providers keep Core's loader.
export function desktopProviders() {
  const engine = createRequire(path.resolve(import.meta.dirname, "../package.json"))
  const manifest = JSON.parse(readFileSync(engine.resolve("./package.json"), "utf8"))
  const packages = [...new Set([provider.package, ...models.map((model) => model.package)])]
  const bundled = packages.map((specifier, index) => {
    const name = specifier.replace(/^aisdk:/, "")
    const factory = factories.get(name)
    if (!factory) throw new Error(`Arena provider ${specifier} has no desktop bundle factory`)
    const pinned = manifest.dependencies[name]
    const installed = JSON.parse(readFileSync(engine.resolve(`${name}/package.json`), "utf8"))
    if (!/^\d+\.\d+\.\d+$/.test(pinned) || installed.version !== pinned)
      throw new Error(
        `Arena provider ${name} must be installed at its declared pin ${pinned}, got ${installed.version}`,
      )
    return { name, factory, entry: Bun.resolveSync(name, path.dirname(engine.resolve("./package.json"))), index }
  })
  let dynamicLoads = 0
  const providerLoads = new Set<string>()
  const entries = bundled.map((item) => item.entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const plugin: BunPlugin = {
    name: "arena-desktop-providers",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^(?:${entries.join("|")})$`) }, (args) => {
        for (const item of bundled) if (args.path === item.entry) providerLoads.add(item.name)
      })
      build.onLoad({ filter: /plugin[/\\]provider[/\\]dynamic\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8")
        const guard = "if (evt.sdk) return"
        if (source.split(guard).length !== 2) throw new Error(`Core's dynamic provider SDK guard changed: ${args.path}`)
        dynamicLoads++
        const imports = bundled.map(
          (item) => `import { ${item.factory} as arenaSDK${item.index} } from ${JSON.stringify(item.entry)}`,
        )
        const cases = bundled.map(
          (item) => `case ${JSON.stringify(item.name)}: evt.sdk = arenaSDK${item.index}(evt.options); return`,
        )
        return {
          loader: "ts",
          contents:
            imports.join("\n") +
            "\n" +
            source.replace(
              guard,
              `${guard}
        if (evt.model.providerID === ${JSON.stringify(PROVIDER_ID)}) {
          switch (evt.package) {
            ${cases.join("\n")}
            default: return yield* Effect.die(new Error("Arena provider is not bundled: " + evt.package))
          }
        }`,
            ),
        }
      })
    },
  }
  return {
    plugin,
    check() {
      if (dynamicLoads !== 1) throw new Error(`Desktop provider hook replaced ${dynamicLoads} modules, expected 1`)
      for (const item of bundled)
        if (!providerLoads.has(item.name)) throw new Error(`Desktop bundle is missing Arena provider ${item.name}`)
    },
  }
}
