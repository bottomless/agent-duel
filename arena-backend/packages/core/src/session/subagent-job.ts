export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Session } from "../session.js"
import type { SessionSchema } from "./schema.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Interface {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
  /**
   * Stops child results from starting a run of this parent. A result still enters the parent's
   * inbox, so the next run that the parent's owner starts delivers it.
   */
  hold: (parentSessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Lets child results start runs of this parent again. */
  release: (parentSessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const make: Effect.Effect<Interface, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()
  const held = new Set<SessionSchema.ID>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      if (info)
        yield* SubagentCompletion.deliver(sessions, jobs, {
          ...info,
          recovery,
          // Stop may land while this observer waits for the child.
          ...(held.has(recovery.parentSessionID) ? { resume: false } : {}),
        })
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  return Service.of({
    start: (recovery: Recovery) =>
      jobs
        .start({
          id: recovery.childSessionID,
          type: "subagent",
          title: recovery.description,
          metadata: {},
          recovery,
          run: Effect.gen(function* () {
            yield* sessions.resume(recovery.childSessionID)
            const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
            const assistant = messages.find(
              (message) =>
                message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
            )
            return SubagentCompletion.text(assistant)
          }),
        })
        .pipe(Effect.setContext(context)),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
    hold: (parent) => Effect.sync(() => void held.add(parent)),
    release: (parent) => Effect.sync(() => void held.delete(parent)),
  })
})

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, Job.node],
})
