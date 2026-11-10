#!/usr/bin/env bun

// Compiles the Arena engine for the desktop app. Run by packages/desktop/scripts/build-arena-runtime.mjs:
//   bun run packages/opencode/script/build-desktop.ts <outfile> <defines as JSON>
//
// Every native file the engine loads ships beside the executable, and a plugin points its loader there.
// Bun extracts a native file it embeds to an unsigned temp file at run time; the hardened runtime's
// library validation refuses to map that ("different Team IDs"). Files beside the executable are
// signed with the app.

import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { BunPlugin } from "bun"
import { desktopProviders } from "./desktop-providers"

const [outfile, rawDefines] = process.argv.slice(2)
if (!outfile || !rawDefines) throw new Error("usage: build-desktop.ts <outfile> <defines as JSON>")
const define: Record<string, string> = JSON.parse(rawDefines)
const outdir = path.dirname(path.resolve(outfile))

const { platform, arch } = process
// Windows has no hardened runtime, and opencode-pty has no Windows build: there the engine keeps
// Bun's embedded copies.
const unix = platform !== "win32"
const engine = createRequire(path.resolve(import.meta.dirname, "../package.json"))
const core = createRequire(path.resolve(import.meta.dirname, "../../core/package.json"))
const packageDir = (from: NodeJS.Require, name: string) => path.dirname(from.resolve(`${name}/package.json`))
const sibling = (name: string) => `path.join(path.dirname(process.execPath), ${JSON.stringify(name)})`

type Shipped = {
  readonly name: string
  readonly source: string
  readonly executable?: boolean
  readonly plugin: BunPlugin
}

function opencodePty(): Shipped {
  const pty = createRequire(core.resolve("@opencode/pty/package.json"))
  const name = "opencode-pty"
  return {
    name,
    source: pty.resolve(`@opencode/pty-${platform}-${arch}${platform === "linux" ? "-gnu" : ""}/bin/opencode-pty`),
    executable: true,
    // Upstream's CLI build embeds the binary and extracts it into the data directory.
    plugin: {
      name: "opencode-pty-binary",
      setup(build) {
        build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
          loader: "js",
          contents: `import path from "node:path"\nexport default ${sibling(name)}`,
        }))
      },
    },
  }
}

// Core resolves the platform package by a computed name, which a compiled executable cannot reach.
// The Arena environment watcher (src/arena/environment-watch.ts) loads the same file on its own.
function parcelWatcher(): Shipped {
  const name = "watcher.node"
  const binding = `@parcel/watcher-${platform}-${arch}${platform === "linux" ? "-glibc" : ""}`
  return {
    name,
    source: engine.resolve(`${binding}/watcher.node`),
    plugin: {
      name: "parcel-watcher-binding",
      setup(build) {
        build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
          loader: "js",
          contents: `import path from "node:path"\nexport default () => require(${sibling(name)})`,
        }))
      },
    },
  }
}

// fff-bun embeds its library through a `type: "file"` import. With a path outside `$bunfs` it loads
// that path when the package resolver finds no installed copy, which it cannot from a compiled executable.
function fff(): Shipped {
  const name = platform === "darwin" ? "libfff_c.dylib" : "libfff_c.so"
  const fffBun = createRequire(core.resolve("@ff-labs/fff-bun/package.json"))
  const binary = `@ff-labs/fff-bin-${platform}-${arch}${platform === "linux" ? "-gnu" : ""}`
  return {
    name,
    source: path.join(packageDir(fffBun, binary), name),
    plugin: {
      name: "fff-library",
      setup(build) {
        build.onLoad({ filter: /fff-bun[/\\]src[/\\]embedded\.ts$/ }, () => ({
          loader: "js",
          contents: `import path from "node:path"\nexport const embeddedLibPath = ${sibling(name)}`,
        }))
      },
    },
  }
}

// bun-pty resolves its library once at module load; BUN_PTY_LIB would also reach every shell it spawns.
// The whole resolver goes, not only its call: its statically analyzable require would still embed the library.
function bunPty(): Shipped {
  const name = `librust_pty${arch === "arm64" ? "_arm64" : ""}.${platform === "darwin" ? "dylib" : "so"}`
  const resolver = "function resolveLibPath(): string {"
  const call = "const libPath = resolveLibPath();"
  return {
    name,
    source: path.join(packageDir(core, "bun-pty"), "rust-pty", "target", "release", name),
    plugin: {
      name: "bun-pty-library",
      setup(build) {
        build.onLoad({ filter: /bun-pty[/\\]src[/\\]terminal\.ts$/ }, (args) => {
          const source = readFileSync(args.path, "utf8")
          const start = source.indexOf(resolver)
          const end = source.indexOf(call)
          if (start < 0 || end < start || source.indexOf("resolveLibPath", end + call.length) >= 0)
            throw new Error(
              `bun-pty changed its loader: ${args.path} no longer has "${resolver}" followed by "${call}"`,
            )
          return {
            loader: "ts",
            contents:
              source.slice(0, start) +
              `const libPath = join(dirname(process.execPath), ${JSON.stringify(name)});` +
              source.slice(end + call.length),
          }
        })
      },
    },
  }
}

const shipped = [parcelWatcher(), ...(unix ? [opencodePty(), fff(), bunPty()] : [])]

for (const item of shipped)
  if (!existsSync(item.source))
    throw new Error(`${item.name} is missing at ${item.source}; run bun install in arena-backend`)

// Windows keeps the non-persistent shell path (core's persistent-pty/binary.bun.ts), so the engine ships no
// opencode-pty there. The package looks up its platform binary when it loads, which a compiled engine cannot.
const windowsPty: BunPlugin = {
  name: "opencode-pty-windows",
  setup(build) {
    build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
      loader: "js",
      contents: "export default undefined",
    }))
  },
}
// Bun keeps `ws` as its built-in module and drops `export * from "ws"` in this side-effect-free module, so the
// compiled engine exits at start with "ws2 is not defined". The names match upstream's CLI build
// (packages/cli/script/build.ts).
const wsReexports: BunPlugin = {
  name: "ws-named-reexports",
  setup(build) {
    build.onLoad({ filter: /platform-node-shared[/\\]dist[/\\]NodeWS\.js$/ }, () => ({
      loader: "js",
      contents:
        'export { createWebSocketStream, extension, Receiver, Sender, subprotocol, WebSocket, WebSocketServer } from "ws"',
    }))
  },
}
const replaced = [...shipped.map((item) => item.plugin), ...(unix ? [] : [windowsPty]), wsReexports]

// A filter that matches nothing does not fail Bun.build: the engine would embed the file again and extract
// it at run time, where library validation refuses it. Count each plugin's loads and fail on a miss.
const loads = new Map(replaced.map((plugin) => [plugin.name, 0]))
const counted = (plugin: BunPlugin): BunPlugin => ({
  name: plugin.name,
  setup(build) {
    plugin.setup({
      ...build,
      onLoad: (options, callback) =>
        build.onLoad(options, (args) => {
          loads.set(plugin.name, (loads.get(plugin.name) ?? 0) + 1)
          return callback(args)
        }),
    })
  },
})

const providers = desktopProviders()
const result = await Bun.build({
  entrypoints: [path.resolve(import.meta.dirname, "../src/index.ts")],
  conditions: ["browser"],
  define,
  plugins: [providers.plugin, ...replaced.map(counted)],
  compile: {
    outfile: path.resolve(outfile),
    // A long-lived engine otherwise keeps its peak heap: collect more often and keep it smaller.
    execArgv: ["--smol"],
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

providers.check()

const missed = replaced.filter((plugin) => loads.get(plugin.name) !== 1)
if (missed.length > 0) {
  for (const plugin of missed)
    console.error(
      `${plugin.name} replaced ${loads.get(plugin.name)} modules, not 1: its filter no longer matches the module it replaces`,
    )
  process.exit(1)
}

for (const item of shipped) {
  const destination = path.join(outdir, item.name)
  copyFileSync(item.source, destination)
  if (item.executable) chmodSync(destination, 0o755)
}
