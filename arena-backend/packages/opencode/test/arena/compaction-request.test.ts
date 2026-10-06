import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ArenaRuntime } from "@/arena/runtime"
import { LLMRequestPrep } from "@/session/llm/request"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderTest } from "../fake/provider"

const model = ProviderTest.model({
  id: ModelV2.ID.make("arena-01"),
  providerID: ProviderV2.ID.make(ArenaRuntime.providerID),
})

const user = {
  id: MessageID.make("msg_test"),
  sessionID: SessionID.make("ses_test"),
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: {
    providerID: ProviderV2.ID.make(ArenaRuntime.providerID),
    modelID: model.id,
    variant: "high",
  },
} satisfies SessionV1.User

const plugin = {
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
    if (name !== "chat.headers") return Effect.succeed(output)
    return Effect.succeed({
      headers: {
        "x-arena-request-id": "spoofed",
        "x-arena-generation-classification": "compaction",
      },
    } as Output)
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as Plugin.Interface

function prepare(agent: string, small = false) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      return yield* LLMRequestPrep.prepare({
        user,
        sessionID: user.sessionID,
        model,
        agent: {
          name: agent,
          mode: "primary",
          prompt: "test",
          options: {},
          permission: [],
        },
        system: [],
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        provider: ProviderTest.info({}, model),
        auth: undefined,
        plugin,
        flags,
        small,
        isWorkflow: false,
      })
    }).pipe(Effect.provide(RuntimeFlags.layer({ client: "test", outputTokenMax: 32_000 }))),
  )
}

describe("Arena compaction request", () => {
  test("sets internal provenance and classification headers that plugins cannot spoof", async () => {
    const compaction = await prepare("compaction")
    const generation = await prepare("build")
    const utility = await prepare("title", true)

    expect(compaction.headers["x-arena-generation-classification"]).toBe("compaction")
    expect(generation.headers["x-arena-generation-classification"]).toBe("generation")
    expect(utility.headers["x-arena-generation-classification"]).toBe("utility")
    expect(compaction.headers["x-arena-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(compaction.headers["x-arena-request-id"]).not.toBe("spoofed")
    expect(generation.headers["x-arena-request-id"]).not.toBe(compaction.headers["x-arena-request-id"])
  })
})
