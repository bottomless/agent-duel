import { describe, expect } from "bun:test"
import { SystemPart } from "@opencode/ai"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool as Registry } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { host } from "../../../core/test/plugin/host"
import { testEffect } from "../../../core/test/lib/effect"
import { codeModeListings } from "../../../core/test/lib/tool"
import { createArenaEnginePlugin } from "@/arena/engine-runtime/plugin"
import { AssignmentRegistry } from "@/arena/proxy"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Registry.node, PluginHooks.node])),
    // Registration captures these services; blocked callbacks must never reach them.
    Layer.mock(FileAccess.Service, {}),
    Layer.mock(Permission.Service, {}),
  ),
)
const blocked = ["session_rename", "session_move", "worktree_create", "worktree_list", "worktree_remove", "models"]
const retained = ["read", "write", "edit", "patch", "shell", "grep", "glob", "subagent"]
const opencodeRetained = ["list_mcp_resources", "read_mcp_resource", "resource"]
const roots = ["a", "b", "off"]
const cases = roots.flatMap((side) => [side, `${side}_child`, `${side}_grandchild`])
const sessionID = (name: string) => Session.ID.make(`ses_code_mode_${name}`)

const setup = Effect.gen(function* () {
  const registry = yield* Registry.Service
  const hooks = yield* PluginHooks.Service
  const assignments = new AssignmentRegistry()
  for (const side of roots) {
    assignments.assign(sessionID(side), {
      runID: `run_${side}`,
      rootSessionID: sessionID(side),
      scopeID: "scope_code_mode",
      assignmentID: `assignment_${side}`,
      telemetry: side !== "off",
    })
  }
  const sessions = new Map(
    cases.map((name) => {
      const parent = name.endsWith("_grandchild")
        ? name.replace("_grandchild", "_child")
        : name.endsWith("_child")
          ? name.replace("_child", "")
          : undefined
      return [
        sessionID(name),
        Schema.decodeUnknownSync(Session.Info)({
          id: sessionID(name),
          ...(parent ? { parentID: sessionID(parent) } : {}),
          projectID: "global",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          location: { directory: "/workspace" },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      ]
    }),
  )
  const registration = () => Effect.succeed({ dispose: Effect.void })
  const context = host({
    provider: { ...host().provider, transform: registration },
    agent: { ...host().agent, transform: registration },
    aisdk: { hook: registration },
    session: {
      hook: (name, callback, options) => hooks.register("session", name, callback, options),
      get: ({ sessionID }) => Effect.succeed(sessions.get(sessionID)!),
    },
    permission: { ...host().permission, hook: (name, callback) => hooks.register("permission", name, callback) },
    shell: { hook: (name, callback) => hooks.register("shell", name, callback) },
    tool: {
      ...registry,
      hook: (name, callback) => hooks.register("tool", name, callback),
    },
  })
  yield* OpenCodeTools.Plugin.effect(context)
  const calls: string[] = []
  yield* registry.transform((editor) => {
    for (const name of retained) {
      editor.add({
        name,
        description: `Retained ${name}`,
        input: Schema.Struct({}),
        execute: () =>
          Effect.sync(() => {
            calls.push(name)
            return { content: name }
          }),
      })
    }
    // Identical names in MCP namespaces and additional OpenCode tools must survive.
    for (const name of [...blocked, "resource"]) {
      editor.add({
        name,
        description: `Retained MCP ${name}`,
        options: { namespace: "mcp.fixture" },
        input: Schema.Struct({}),
        execute: () => Effect.succeed({ content: `mcp.${name}` }),
      })
    }
    for (const name of opencodeRetained) {
      editor.add({
        name,
        description: `Retained OpenCode ${name}`,
        options: { namespace: "opencode" },
        input: Schema.Struct({}),
        execute: () => Effect.succeed({ content: name }),
      })
    }
  })
  yield* createArenaEnginePlugin({ enabled: true, assignments, gate: () => Effect.void }).effect(context)
  const run = (name: string, code: string) =>
    registry.snapshot().pipe(
      Effect.flatMap((snapshot) =>
        snapshot.execute({
          sessionID: sessionID(name),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_code_mode"),
          call: { type: "tool-call", id: "call_code_mode", name: "execute", input: { code } },
        }),
      ),
    )
  return { registry, hooks, run, calls }
})

describe("Arena Code Mode policy", () => {
  for (const tool of blocked) {
    it.live(`hides and blocks opencode.${tool} for both sides, Battle off and descendants`, () =>
      Effect.gen(function* () {
        const h = yield* setup
        expect((yield* h.registry.list()).map((item) => item.id)).not.toContain(`opencode_${tool}`)
        const snapshot = yield* h.registry.snapshot()
        const catalog = snapshot.codeModeCatalog!
        const prompt = CodeModeInstructions.render(CodeModeCatalog.summarize(catalog))
        expect(codeModeListings(catalog).map((item) => item.path)).not.toContain(`tools.opencode.${tool}`)
        expect(prompt).not.toContain(`tools.opencode.${tool}`)
        expect(prompt).not.toContain("working with sessions and worktrees")
        expect(prompt).not.toContain("searching the available models")
        for (const name of cases) {
          const search = yield* h.run(
            name,
            `return search({ query: ${JSON.stringify(tool)} }).items.map(item => item.path)`,
          )
          expect(search.output).toMatchObject({
            output: expect.stringContaining(`tools.mcp.fixture.${tool}`),
            toolCalls: [{ tool: "search", status: "completed", input: { query: tool } }],
            files: [],
          })
          expect(search.metadata?.error).toBeUndefined()
          expect(JSON.stringify(search.output)).not.toContain(`tools.opencode.${tool}`)
          const result = yield* h.run(name, `return await tools.opencode.${tool}({})`)
          expect(result.output).toMatchObject({ error: true, toolCalls: [] })
        }
      }),
    )
  }

  for (const kind of ["context", "compaction", "generate"] as const) {
    it.live(`removes Core's worktree advice from ${kind} prompts for roots and descendants`, () =>
      Effect.gen(function* () {
        const h = yield* setup
        for (const name of cases) {
          const event = yield* h.hooks.trigger("session", kind, {
            sessionID: sessionID(name),
            agent: Agent.ID.make("build"),
            model: Schema.decodeUnknownSync(Model.Ref)({ providerID: "arena", id: "contestant" }),
            system: [SystemPart.make("Keep the user's project instructions.")],
            messages: [],
            tools: {},
            options: {},
          })
          const text = event.system.map((part) => part.text).join("\n")
          expect(text).toContain("Keep the user's project instructions.")
          for (const tool of blocked) expect(text).not.toContain(`tools.opencode.${tool}`)
        }
      }),
    )
  }

  it.live("keeps filesystem, shell, child-agent, MCP and other OpenCode tools callable through execute", () =>
    Effect.gen(function* () {
      const h = yield* setup
      for (const name of cases) {
        for (const tool of retained) {
          const result = yield* h.run(name, `return await tools.${tool}({})`)
          expect(result.output).toMatchObject({ output: tool, toolCalls: [{ tool, status: "completed" }] })
        }
        for (const tool of [...blocked, "resource"]) {
          const result = yield* h.run(name, `return await tools.mcp.fixture.${tool}({})`)
          expect(result.output).toMatchObject({ output: `mcp.${tool}` })
        }
        for (const tool of opencodeRetained) {
          expect((yield* h.run(name, `return await tools.opencode.${tool}({})`)).output).toMatchObject({ output: tool })
        }
      }
      expect(h.calls).toEqual(cases.flatMap(() => retained))
      yield* h.registry.reload()
      for (const tool of blocked)
        expect((yield* h.registry.list()).map((item) => item.id)).not.toContain(`opencode_${tool}`)
    }),
  )
})
