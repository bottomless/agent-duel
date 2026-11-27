import { expect, test } from "bun:test"
import { Config } from "@opencode/core/config"
import { ConfigCompactionPlugin } from "@opencode/core/config/plugin/compaction"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Layer, Stream } from "effect"
import { host } from "../plugin/host"

// Agent Duel vendor patch: a project's opencode.json can come from a contestant's winning edit, so config never turns
// background summaries back on; its other compaction settings still apply.
test("background summaries stay off when config turns them on", async () => {
  const settings: Record<string, unknown> = {}
  const compaction = Layer.mock(SessionCompaction.Service)({
    transform: (update) =>
      Effect.sync(() => update({ configure: (next) => void Object.assign(settings, next) })) as never,
    reload: () => Effect.void,
  })
  const config = Config.testLayer([
    new Document({
      type: "document",
      info: new Info({ compaction: new ConfigCompaction.Info({ background: true, buffer: 10_000 }) }),
    }),
  ])
  await Effect.runPromise(
    ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => Stream.empty } })).pipe(
      Effect.provide(Layer.merge(config, compaction)),
      Effect.scoped,
    ),
  )
  expect(settings).toMatchObject({ background: false, buffer: 10_000 })
})
