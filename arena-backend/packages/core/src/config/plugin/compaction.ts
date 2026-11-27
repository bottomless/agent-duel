export * as ConfigCompactionPlugin from "./compaction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { SessionCompaction } from "../../session/compaction.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.compaction",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const compaction = yield* SessionCompaction.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, compaction.reload())
    yield* compaction.transform((editor) => {
      // Agent Duel vendor patch: background summaries stay off, whatever config says. A summary started at the end
      // of a contestant's turn would be a paid request after the turn, a project's opencode.json can come from a
      // contestant's winning edit, and Arena compacts on its own ceiling.
      editor.configure({ background: false })
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.compaction) continue
        editor.configure({
          ...(entry.info.compaction.auto === undefined ? {} : { auto: entry.info.compaction.auto }),
          ...(entry.info.compaction.buffer === undefined ? {} : { buffer: entry.info.compaction.buffer }),
          ...(entry.info.compaction.keep?.tokens === undefined ? {} : { keep: entry.info.compaction.keep.tokens }),
        })
      }
    })
  }),
})
