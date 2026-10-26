import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { CurrentDirectory } from "@/project/instance-context"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { ArenaService } from "./service"
import { createArenaEnginePlugin } from "./engine-runtime/plugin"
import { Service as V2EventsService, layer as v2EventsLayer } from "./v2-events"
import { SessionRuntime } from "./session-runtime"
import { ArenaApi } from "@/server/routes/instance/httpapi/groups/arena"
import { arenaHandlers } from "@/server/routes/instance/httpapi/handlers/arena"

/** Register the Arena model/provider plugin before a Location graph is opened. */
export const enginePluginLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const plugins = yield* SdkPlugins.Service
    yield* plugins.register(createArenaEnginePlugin())
  }),
)

/**
 * Arena's V2 services are installed into the host's existing Core graph. The
 * daemon boot must provide this layer to the context returned by the official
 * server routes; it must not build a second Session or Database graph.
 */
const configLayer = Config.layer
const gitLayer = Git.layer
const instanceLayer = InstanceStore.layer
const sessionLayer = SessionRuntime.arenaSessionRuntimeLayer
const imageLayer = Image.layer.pipe(Layer.provideMerge(configLayer))
const worktreeLayer = Worktree.layer.pipe(Layer.provideMerge(gitLayer), Layer.provideMerge(instanceLayer))
const arenaLayer = ArenaService.layer.pipe(
  Layer.provideMerge(sessionLayer),
  Layer.provideMerge(worktreeLayer),
  Layer.provideMerge(imageLayer),
  Layer.provideMerge(gitLayer),
  Layer.provideMerge(instanceLayer),
  Layer.provideMerge(configLayer),
)

const v2EventsRuntimeLayer = v2EventsLayer.pipe(Layer.provideMerge(arenaLayer))

export const layer = Layer.mergeAll(
  sessionLayer,
  configLayer,
  gitLayer,
  instanceLayer,
  imageLayer,
  worktreeLayer,
  arenaLayer,
  v2EventsRuntimeLayer,
  enginePluginLayer,
)

/** Arena's typed `/arena/...` group, installed into the official router. */
const currentDirectoryMiddleware = HttpRouter.middleware()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    const directory = request.headers["x-opencode-directory"]
    if (!pathname.startsWith("/arena/") || !directory) return yield* effect
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    return yield* effect.pipe(Effect.provideService(CurrentDirectory, ref))
  }),
).layer

const providedArenaHandlers = arenaHandlers.pipe(HttpRouter.provideRequest(layer), Layer.provideMerge(layer))

export const routeLayer = HttpApiBuilder.layer(ArenaApi).pipe(
  Layer.provide(providedArenaHandlers),
  // Keep the Arena service in the host context as well as satisfying the
  // custom route handlers; the native /api boundary uses it for prompt
  // admission and terminal reconciliation.
  Layer.provideMerge(layer),
  Layer.provide(currentDirectoryMiddleware),
)

export { ArenaService, V2EventsService }
