import { describe, expect, test } from "bun:test"
import { FlagResolve } from "@opencode/core/flag/resolve"
import { Document, Info } from "@opencode/schema/config"
import { ConfigFlag } from "@opencode/schema/config/flag"
import { Server } from "../../src/server/server"

// A project's opencode.json can come from a contestant's winning edit, so config must not turn flags on in the engine.
describe("engine flags", () => {
  test("stay off when config turns every flag on", () => {
    const entries = [
      new Document({
        type: "document",
        info: new Info({ experimental: { all_flags: true, full_codemode: true, machines: true } as never }),
      }),
    ]
    const flags = FlagResolve.resolve({ entries, channel: "unknown", overrides: Server.engineFlags })
    expect(Object.keys(flags).toSorted()).toEqual(Object.keys(ConfigFlag.registry).toSorted())
    for (const [key, state] of Object.entries(flags)) expect([key, state.enabled]).toEqual([key, false])
    // Without the engine's override the same config turns them on.
    expect(FlagResolve.resolve({ entries, channel: "unknown" }).full_codemode.enabled).toBe(true)
  })
})
