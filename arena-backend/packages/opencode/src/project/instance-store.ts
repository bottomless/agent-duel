import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode/util/effect/app-node"
import { AbsolutePath } from "@opencode/core/schema"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { FSUtil } from "@opencode/util/fs-util"
import { Shell } from "@opencode/core/shell"
import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import type { Instance } from "@opencode/core/instance"
import { Context, Effect, Layer, RcMap } from "effect"
import { CurrentDirectory, fromLocation, type InstanceContext } from "./instance-context"

export interface LoadInput {
  readonly directory: string
  readonly worktree?: string
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext, Error>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext, Error>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void, Error>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void, Error>
  readonly loaded: (directory: string) => Effect.Effect<boolean>
  readonly disposeAll: () => Effect.Effect<void, Error>
  readonly provide: <A, E, R>(
    input: LoadInput,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Error, Exclude<R, Instance.Services>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

const resolve = (directory: string) => FSUtil.resolve(directory)

const ref = (directory: string): Location.Ref =>
  Location.Ref.make({
    directory: AbsolutePath.make(resolve(directory)),
    ...(WorkspaceContext.workspaceID ? { workspaceID: WorkspaceContext.workspaceID } : {}),
  })

const contextFor = (locations: Context.Service.Shape<typeof LocationServiceMap.Service>, directory: string) =>
  Effect.scoped(Location.Service.pipe(Effect.provide(locations.get(ref(directory)))))

const emitDisposed = (directory: string, project?: string) =>
  Effect.sync(() =>
    GlobalBus.emit("event", {
      directory,
      project,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: { directory },
      },
    }),
  )

export const layer: Layer.Layer<Service, never, LocationServiceMap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    const load = Effect.fn("InstanceStore.load")(function* (input: LoadInput) {
      const directory = resolve(input.directory)
      const ctx = fromLocation(yield* contextFor(locations, directory))
      return input.worktree === undefined ? ctx : { ...ctx, worktree: input.worktree }
    })

    const reload = Effect.fn("InstanceStore.reload")(function* (input: LoadInput) {
      const directory = resolve(input.directory)
      yield* locations.invalidate(ref(directory))
      return yield* load(input)
    })

    // The map keys Locations by their canonical ref (LocationServiceMap.canonical); a ref built here
    // compares unequal to it even when it prints the same, so look entries up the same way.
    const isActive = (key: Location.Ref) => RcMap.has(locations.rcMap, LocationServiceMap.canonical(key))

    // Core runs local shell commands in the process daemon, where they outlive the Location that started them.
    // A disposed directory's work is over (a contestant's dev server, a stopped chat's command), so end them first.
    const endShells = Effect.fnUntraced(function* (key: Location.Ref) {
      // An inactive Location has no commands of this server to end; building one here would only be thrown away.
      if (!(yield* isActive(key))) return
      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        // Removing a running command ends it as killed, which also settles the job waiting on it.
        for (const info of yield* shell.list()) yield* shell.remove(info.id).pipe(Effect.ignore)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(key)),
        Effect.catch((error) => Effect.logWarning("failed to end a disposed directory's shells", { error })),
      )
    })

    const invalidate = (key: Location.Ref) => endShells(key).pipe(Effect.andThen(locations.invalidate(key)))

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (directory: string) {
      const resolved = resolve(directory)
      const key = ref(resolved)
      const active = yield* isActive(key)
      if (!active) return
      const ctx = fromLocation(yield* contextFor(locations, resolved))
      yield* invalidate(key)
      yield* emitDisposed(resolved, ctx.project.id)
    })

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      yield* invalidate(ref(ctx.directory))
      yield* emitDisposed(ctx.directory, ctx.project.id)
    })

    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      const refs = Array.from(yield* RcMap.keys(locations.rcMap))
      yield* Effect.forEach(refs, (item) => invalidate(item), {
        concurrency: "unbounded",
        discard: true,
      })
    })

    const loaded = (directory: string) => isActive(ref(directory))

    const provide = <A, E, R>(
      input: LoadInput,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | Error, Exclude<R, Instance.Services>> => {
      const directory = resolve(input.directory)
      const locationLayer = locations.get(ref(directory))
      return Effect.gen(function* () {
        const ctx = fromLocation(yield* Location.Service)
        const projected = input.worktree === undefined ? ctx : { ...ctx, worktree: input.worktree }
        return yield* effect.pipe(
          Effect.provideService(InstanceRef, projected),
          Effect.provideService(CurrentDirectory, ref(directory)),
        )
      }).pipe(Effect.provide(locationLayer))
    }

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))
    return Service.of({ load, reload, dispose, disposeDirectory, loaded, disposeAll, provide })
  }),
)

export const locationServiceMapNode = LayerNode.unbound(LocationServiceMap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [locationServiceMapNode],
})

export * as InstanceStore from "./instance-store"
