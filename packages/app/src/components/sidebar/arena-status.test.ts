import { describe, expect, it } from "vitest";
import type { ArenaActivity } from "@getpaseo/protocol/arena/activity";
import { workspaceBattleStatus } from "./arena-status";

const completedBattle: ArenaActivity = {
  sessionID: "session",
  chatID: "chat",
  turnID: "turn",
  agentId: "agent",
  workspaceId: "workspace",
  title: "Resolve conflicts",
  stale: false,
  state: "complete",
  resolved: true,
  requiresDecision: false,
  runs: [],
};

describe("workspaceBattleStatus", () => {
  it("shows a check when a follow-up agent finishes after the battle", () => {
    expect(
      workspaceBattleStatus({ arenaActivity: completedBattle, statusBucket: "attention" }),
    ).toEqual({ bucket: "attention", label: "Ready to review", icon: "ready" });
  });

  it.each([
    { bucket: "running", label: "Working", icon: "running" },
    { bucket: "needs_input", label: "Needs input", icon: "alert" },
    { bucket: "failed", label: "Failed", icon: "alert" },
    { bucket: "done", label: "Battle complete", icon: "idle" },
  ] as const)("keeps the $bucket indicator after a battle", (expected) => {
    expect(
      workspaceBattleStatus({ arenaActivity: completedBattle, statusBucket: expected.bucket }),
    ).toEqual(expected);
  });

  it("keeps the check and decision label while waiting for a vote", () => {
    expect(
      workspaceBattleStatus({
        arenaActivity: { ...completedBattle, resolved: false, requiresDecision: true },
        statusBucket: "attention",
      }),
    ).toEqual({ bucket: "attention", label: "Ready to choose", icon: "ready" });
  });

  it("keeps a battle failure visible over a finished agent", () => {
    expect(
      workspaceBattleStatus({
        arenaActivity: { ...completedBattle, state: "interrupted_recovery" },
        statusBucket: "attention",
      }),
    ).toEqual({ bucket: "failed", label: "Battle needs attention", icon: "alert" });
  });

  it("keeps stale battle status unknown", () => {
    expect(
      workspaceBattleStatus({
        arenaActivity: { ...completedBattle, stale: true },
        statusBucket: "attention",
      }),
    ).toEqual({ bucket: "done", label: "Battle status unavailable", icon: "unknown" });
  });

  it("leaves workspaces without a battle to the normal sidebar indicator", () => {
    expect(workspaceBattleStatus({ statusBucket: "attention" })).toBeNull();
  });
});
