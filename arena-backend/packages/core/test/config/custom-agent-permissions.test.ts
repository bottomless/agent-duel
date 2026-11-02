import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { Document, Info } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))

it.live("config-only agents ask outside the project and keep their configured rules", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const ctx = host({ agent: agentHost(agents) })
    yield* AgentPlugin.Plugin.effect(ctx)
    expect(yield* agents.get(Agent.ID.make("custom"))).toBeUndefined()

    // Config agents are created after the engine's transforms of existing agents.
    yield* ConfigAgentPlugin.Plugin.effect(ctx).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({
            type: "document",
            info: Schema.decodeUnknownSync(Info)({
              agents: {
                custom: {},
                configured: {
                  permissions: [
                    { action: "external_directory", resource: "*", effect: "allow" },
                    { action: "external_directory", resource: "/outside/denied/*", effect: "deny" },
                  ],
                },
              },
            }),
          }),
        ]),
      ),
    )

    const custom = yield* agents.get(Agent.ID.make("custom"))
    if (!custom) throw new Error("expected config-defined agent")
    expect(Permission.evaluate("external_directory", "/outside/new/*", custom.permissions).effect).toBe("ask")
    expect(Permission.evaluate("edit", "inside.txt", custom.permissions).effect).toBe("allow")
    expect(Permission.evaluate("shell", "echo hi", custom.permissions).effect).toBe("allow")
    expect(Permission.evaluate("read", ".env", custom.permissions).effect).toBe("ask")

    const configured = yield* agents.get(Agent.ID.make("configured"))
    if (!configured) throw new Error("expected agent with configured rules")
    expect(Permission.evaluate("external_directory", "/outside/allowed/*", configured.permissions).effect).toBe("allow")
    expect(Permission.evaluate("external_directory", "/outside/denied/*", configured.permissions).effect).toBe("deny")
  }),
)
