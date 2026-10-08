import { describe, expect, it } from "vitest";
import { arenaResolutionStatus, arenaSetupStatus } from "./transition-progress";

describe("battle transition progress", () => {
  it("shows concurrent work in stable order, then only the work still active", () => {
    expect(
      arenaResolutionStatus({
        state: "applying",
        activeOperations: ["updating_conversation", "applying_changes", "releasing_loser"],
      }),
    ).toBe(
      "Applying changes to your workspace · Updating the conversation · Releasing the other environment",
    );
    expect(
      arenaResolutionStatus({
        state: "canonicalizing",
        activeOperations: ["updating_conversation"],
      }),
    ).toBe("Updating the conversation");
    expect(
      arenaResolutionStatus({
        state: "cleanup_pending",
        activeOperations: ["releasing_loser"],
      }),
    ).toBe("Releasing the other environment");
  });

  it("does not claim a process is stopping when application has no reported operation", () => {
    expect(arenaResolutionStatus({ state: "applying", activeOperations: [] })).toBe(
      "Preparing the selected result",
    );
    expect(arenaResolutionStatus({ state: "early_selected" })).toBe(
      "Finishing the other agent's run",
    );
    expect(
      arenaResolutionStatus({ state: "applying", activeOperations: ["checking_workspace"] }),
    ).toBe("Checking workspace changes");
  });

  it("keeps environment copying visible when model requests have already started", () => {
    expect(arenaSetupStatus({ state: "running", activeOperations: ["copying_environment"] })).toBe(
      "Copying files and dependencies",
    );
    expect(arenaSetupStatus({ state: "running", activeOperations: [] })).toBeNull();
  });

  it("does not let stale operations outlive completion, failure or stop", () => {
    for (const state of [
      "complete",
      "application_failed",
      "canonicalization_failed",
      "interrupted_recovery",
      "awaiting_vote",
      "stopping",
      "creation_failed",
    ] as const) {
      const turn: Parameters<typeof arenaSetupStatus>[0] = {
        state,
        activeOperations: ["copying_environment", "applying_changes"],
      };
      expect(arenaSetupStatus(turn)).toBeNull();
      expect(arenaResolutionStatus(turn)).toBeNull();
    }
    expect(arenaResolutionStatus(undefined)).toBeNull();
  });

  it("uses setup state before operations arrive without replaying earlier cleanup", () => {
    expect(arenaSetupStatus(undefined)).toBe("Preparing workspaces");
    expect(arenaSetupStatus({ state: "creating" })).toBe("Preparing workspaces");
    expect(arenaSetupStatus({ state: "worktrees_ready" })).toBe("Starting agents");
    expect(
      arenaSetupStatus({ state: "running", activeOperations: ["applying_changes"] }),
    ).toBeNull();
  });
});
