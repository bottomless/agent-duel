import type { SessionInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";

import type { V2Api } from "./api.js";
import {
  applyResumeOverrides,
  applySelection,
  features,
  permissionRules,
  requiresDedicatedV2Server,
  arenaModelRef,
} from "./configuration.js";

test("Arena selects an opaque model and its fixed reasoning profile", () => {
  expect(arenaModelRef()).toEqual({ providerID: "arena", id: "medium", variant: "xhigh" });
  expect(arenaModelRef("arena/contestant")).toEqual({
    providerID: "arena",
    id: "contestant",
    variant: "high",
  });
  expect(() => arenaModelRef("openrouter/private-model")).toThrow(
    "Choose an Arena Medium or frontier model",
  );
});

describe("OpenCode v2 permission rules", () => {
  test("maps authored native permissions and exact injected MCP grants", () => {
    expect(
      permissionRules({
        provider: "opencode",
        cwd: "/tmp/project",
        providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
        toolPolicy: { preapproved: [{ server: "paseo.host", tool: "read/info" }] },
      }),
    ).toEqual([
      { action: "paseo_host_read_info", resource: "*", effect: "allow" },
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  });
});

describe("OpenCode v2 helper isolation", () => {
  test("shares the helper for agent-identity environment only", () => {
    expect(
      requiresDedicatedV2Server(
        { provider: "opencode", cwd: "/tmp/project" },
        { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
      ),
    ).toBe(false);
  });

  test("dedicates a helper for any other process environment", () => {
    expect(
      requiresDedicatedV2Server(
        { provider: "opencode", cwd: "/tmp/project" },
        { agentId: "agent", env: { CUSTOM_FLAG: "1" } },
      ),
    ).toBe(true);
  });

  test("dedicates a helper when the session carries custom MCP", () => {
    expect(
      requiresDedicatedV2Server({
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      }),
    ).toBe(true);
  });
});

describe("OpenCode v2 features", () => {
  test("reports the auto-accept toggle from the session value", () => {
    expect(features({ provider: "opencode", cwd: "/tmp/project" })).toEqual([
      { type: "toggle", id: "auto_accept", label: "Auto-accept", value: false },
    ]);
    expect(
      features({
        provider: "opencode",
        cwd: "/tmp/project",
        featureValues: { auto_accept: true },
      }),
    ).toEqual([{ type: "toggle", id: "auto_accept", label: "Auto-accept", value: true }]);
  });
});

describe("OpenCode v2 resume overrides", () => {
  // The shape the generated client throws for the engine's declared 400 refusal body.
  function arenaRefusal() {
    return Object.assign(new Error("This chat has an unresolved battle."), {
      name: "ArenaRefusal",
    });
  }
  function fakeClient(fail: () => Error | undefined) {
    const calls: string[] = [];
    const client = {
      session: {
        switchAgent: async (input: { agent: string }) => {
          calls.push(`agent:${input.agent}`);
          const error = fail();
          if (error) throw error;
        },
        switchModel: async (input: { model: { id: string } }) => {
          calls.push(`model:${input.model.id}`);
          const error = fail();
          if (error) throw error;
        },
      },
    } as unknown as V2Api;
    return { client, calls };
  }
  function sessionInfo(): SessionInfo {
    return {
      id: "ses_canonical",
      agent: "build",
      model: { providerID: "arena", id: "contestant", variant: "high" },
    } as unknown as SessionInfo;
  }

  test("defers a refused agent and model and applies them once Arena accepts", async () => {
    let battleOpen = true;
    const { client, calls } = fakeClient(() => (battleOpen ? arenaRefusal() : undefined));
    const info = sessionInfo();
    const deferred = await applyResumeOverrides(
      client,
      info,
      { modeId: "plan", model: "arena/medium" },
      true,
    );
    expect(calls).toEqual(["agent:plan", "model:medium"]);
    expect(info.agent).toBe("build");
    expect(info.model).toEqual({ providerID: "arena", id: "contestant", variant: "high" });
    expect(deferred).toEqual({
      agent: "plan",
      model: { providerID: "arena", id: "medium", variant: "xhigh" },
    });

    // Still refused while the battle is open: nothing is lost.
    expect(await applySelection(client, info, deferred, true)).toEqual(deferred);
    battleOpen = false;
    expect(await applySelection(client, info, deferred, true)).toEqual({});
    expect(info.agent).toBe("plan");
    expect(info.model).toEqual({ providerID: "arena", id: "medium", variant: "xhigh" });
  });

  test("fills a migrated session that has no model once the battle resolves", async () => {
    let battleOpen = true;
    const { client } = fakeClient(() => (battleOpen ? arenaRefusal() : undefined));
    // OpenCode 1.x passed the model per prompt, so a migrated canonical session has none.
    const info = { id: "ses_migrated" } as unknown as SessionInfo;
    const deferred = await applyResumeOverrides(
      client,
      info,
      { model: "arena/contestant", thinkingOptionId: "xhigh" },
      true,
    );
    expect(info.model).toBeUndefined();
    expect(deferred).toEqual({ model: { providerID: "arena", id: "contestant", variant: "high" } });
    battleOpen = false;
    await applySelection(client, info, deferred, true);
    expect(info.model).toEqual({ providerID: "arena", id: "contestant", variant: "high" });
  });

  test("opens a chat saved with a pre-Arena OpenRouter model on the session's own model", async () => {
    const legacy = {
      modeId: "build",
      model: "openrouter/deepseek/deepseek-v4-flash",
      thinkingOptionId: "high",
    };
    const kept = fakeClient(() => undefined);
    const info = sessionInfo();
    expect(await applyResumeOverrides(kept.client, info, legacy, true)).toEqual({});
    expect(kept.calls).toEqual(["agent:build"]);
    expect(info.model).toEqual({ providerID: "arena", id: "contestant", variant: "high" });

    // A session that holds no model gets the default size instead.
    const filled = fakeClient(() => undefined);
    const empty = { id: "ses_migrated" } as unknown as SessionInfo;
    expect(await applyResumeOverrides(filled.client, empty, legacy, true)).toEqual({});
    expect(filled.calls).toEqual(["agent:build", "model:medium"]);
    expect(empty.model).toEqual({ providerID: "arena", id: "medium", variant: "xhigh" });
  });

  test("applies accepted switches and still fails on any other error", async () => {
    const accepted = fakeClient(() => undefined);
    const info = sessionInfo();
    expect(
      await applyResumeOverrides(
        accepted.client,
        info,
        { modeId: "build", model: "arena/medium" },
        true,
      ),
    ).toEqual({});
    expect(info.model).toEqual({ providerID: "arena", id: "medium", variant: "xhigh" });

    const transport = fakeClient(() => new Error("Transport"));
    await expect(
      applyResumeOverrides(transport.client, sessionInfo(), { modeId: "build" }, true),
    ).rejects.toThrow("Transport");
    // Outside Arena mode no refusal is expected, so it is not swallowed either.
    const plain = fakeClient(arenaRefusal);
    await expect(
      applyResumeOverrides(plain.client, sessionInfo(), { modeId: "build" }, false),
    ).rejects.toThrow("unresolved battle");
  });
});
