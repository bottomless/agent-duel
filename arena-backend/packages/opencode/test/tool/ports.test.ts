import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ArenaContestant } from "@/arena/contestant"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const arena = ProviderV2.ID.make("arena")
const modelID = ModelV2.ID.make("contestant")
const sandbox = ArenaContestant.contestantPermissions(undefined, {
  tmp: ArenaContestant.tmpDirectory("session"),
  skills: [],
})

describe("tool.ports", () => {
  it.instance("is offered only to a battle contestant", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* (yield* Agent.Service).get("build")
      const offered = (input: { providerID: ProviderV2.ID; permission?: typeof sandbox }) =>
        registry
          .tools({ modelID, agent, ...input })
          .pipe(Effect.map((tools) => tools.some((tool) => tool.id === "ports")))

      expect(yield* offered({ providerID: arena, permission: sandbox })).toBe(true)
      // A single-agent Arena turn has no sandbox and no port bank.
      expect(yield* offered({ providerID: arena })).toBe(false)
      expect(yield* offered({ providerID: ProviderV2.ID.make("test"), permission: sandbox })).toBe(false)
    }),
  )
})
