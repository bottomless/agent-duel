import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Logger } from "effect"
import { LayerNode } from "../src/effect/layer-node.js"
import { filesystem } from "../src/effect/app-node-platform.js"
import { Logging } from "../src/observability/logging.js"

test("the daemon log hook overrides local and release paths and receives engine output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arena-engine-log-"))
  const target = path.join(directory, "nested", "engine.log")
  const previous = process.env.OPENCODE_LOG_FILE
  process.env.OPENCODE_LOG_FILE = target
  try {
    expect(Logging.file(true, "local")).toBe(target)
    expect(Logging.file(false, "release")).toBe(target)
    await Effect.gen(function* () {
      const logger = yield* Logging.fileLogger()
      yield* Effect.logInfo("engine merge regression").pipe(Effect.provide(Logger.layer([logger])))
    }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(filesystem)), Effect.runPromise)
    expect(await fs.readFile(target, "utf8")).toContain("engine merge regression")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_LOG_FILE
    else process.env.OPENCODE_LOG_FILE = previous
    await fs.rm(directory, { recursive: true, force: true })
  }
})
