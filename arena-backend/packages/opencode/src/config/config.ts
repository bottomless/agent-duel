import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Config as CoreConfig } from "@opencode/core/config"
import type { Info as ConfigInfo } from "@opencode/schema/config"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Context, Effect, Layer } from "effect"
import { mergeDeep } from "remeda"
import { CurrentDirectory } from "@/project/instance-context"

export type Info = ConfigInfo & {
  readonly attachment?: {
    readonly image?: {
      readonly auto_resize?: boolean
      readonly max_width?: number
      readonly max_height?: number
      readonly max_base64_bytes?: number
    }
  }
}

export class Service extends Context.Service<
  Service,
  {
    readonly get: () => Effect.Effect<Info, Error>
  }
>()("@agent-duel/ArenaConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return Service.of({
      get: Effect.fn("ArenaConfig.get")(function* () {
        const current = yield* CurrentDirectory
        const entries = yield* Effect.scoped(
          CoreConfig.Service.use((config) => config.entries()).pipe(Effect.provide(locations.get(current))),
        )
        return entries.reduce<Info>(
          (info, entry) => (entry.type === "document" ? mergeDeep(info, entry.info) : info),
          {},
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [LocationServiceMap.node] })
export * as Config from "./config"
