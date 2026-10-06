import { describe, expect, test, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

import type { ManagedAgent } from "./agent/agent-manager.js";
import { applyArenaFirstTurnMetadata } from "./arena-workspace-auto-name.js";

function arenaAgent(): ManagedAgent {
  return {
    workspaceId: "workspace-arena",
    cwd: "/repo",
    provider: "opencode",
    config: {
      provider: "opencode",
      cwd: "/repo",
      model: "openrouter/deepseek/deepseek-v4-flash",
      thinkingOptionId: "high",
    },
  } as ManagedAgent;
}

describe("applyArenaFirstTurnMetadata", () => {
  test("titles the agent and schedules the workspace with the configured solo model", async () => {
    const scheduleForDirectory = vi.fn();
    const updateAgentTitle = vi.fn(async () => {});

    await applyArenaFirstTurnMetadata({
      agent: arenaAgent(),
      snapshot: { turn: { index: 0 } } as ArenaSnapshot,
      prompt: "Fix Arena workspace names",
      updateAgentTitle,
      workspaceAutoName: { scheduleForDirectory },
    });

    expect(updateAgentTitle).toHaveBeenCalledWith("Fix Arena workspace names");
    expect(scheduleForDirectory).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-arena",
        cwd: "/repo",
        firstAgentContext: { prompt: "Fix Arena workspace names" },
      },
      {
        preferredSelection: {
          provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4-flash",
          thinkingOptionId: "high",
        },
      },
    );
  });

  test("does not regenerate metadata for a later turn", async () => {
    const scheduleForDirectory = vi.fn();
    const updateAgentTitle = vi.fn(async () => {});

    await applyArenaFirstTurnMetadata({
      agent: arenaAgent(),
      snapshot: { turn: { index: 1 } } as ArenaSnapshot,
      prompt: "Add one more thing",
      updateAgentTitle,
      workspaceAutoName: { scheduleForDirectory },
    });

    expect(updateAgentTitle).not.toHaveBeenCalled();
    expect(scheduleForDirectory).not.toHaveBeenCalled();
  });
});
