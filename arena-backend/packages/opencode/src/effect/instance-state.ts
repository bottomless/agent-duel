import { Effect } from "effect"
import { fromLocation } from "@/project/instance-context"
import { Location } from "@opencode/core/location"
import { WorkspaceRef } from "./instance-ref"
import { WorkspaceContext } from "@/control-plane/workspace-context"

export const context = Effect.gen(function* () {
  return fromLocation(yield* Location.Service)
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export * as InstanceState from "./instance-state"
