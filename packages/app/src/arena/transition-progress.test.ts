import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { describe, expect, it } from "vitest";
import { arenaResolutionStatus, arenaSetupStatus } from "./transition-progress";

type Resolution = NonNullable<ArenaSnapshot["turn"]>["resolution"];

const keptStopResolutions = [
  { kind: "stopped", resolution: "apply_a", appliedSide: "a" },
  { kind: "stopped", resolution: "apply_b", appliedSide: "b" },
] satisfies Resolution[];

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

  it.each(keptStopResolutions)(
    "shows active work after Keep $appliedSide is committed before applying",
    (resolution) => {
      expect(
        arenaResolutionStatus({
          state: "awaiting_stop_resolution",
          resolution,
          activeOperations: ["preserving_results"],
        }),
      ).toBe("Saving battle results");
      expect(
        arenaResolutionStatus({
          state: "awaiting_stop_resolution",
          resolution,
          activeOperations: ["preserving_results", "checking_workspace"],
        }),
      ).toBe("Checking workspace changes · Saving battle results");
    },
  );

  it.each(keptStopResolutions)(
    "prepares the selected result after Keep $appliedSide when no operation is reported",
    (resolution) => {
      expect(arenaResolutionStatus({ state: "awaiting_stop_resolution", resolution })).toBe(
        "Preparing the selected result",
      );
      expect(
        arenaResolutionStatus({
          state: "awaiting_stop_resolution",
          resolution,
          activeOperations: [],
        }),
      ).toBe("Preparing the selected result");
    },
  );

  it.each([
    undefined,
    { kind: "stopped", resolution: "discard" },
    { kind: "vote", vote: "a", appliedSide: "a" },
    { kind: "early", vote: "b", appliedSide: "b" },
    { kind: "aborted", reason: "Battle could not start" },
  ] satisfies Resolution[])(
    "suppresses stop-resolution progress without a committed kept side (%j)",
    (resolution) => {
      expect(arenaResolutionStatus({ state: "awaiting_stop_resolution", resolution })).toBeNull();
      expect(
        arenaResolutionStatus({
          state: "awaiting_stop_resolution",
          resolution,
          activeOperations: ["preserving_results"],
        }),
      ).toBeNull();
    },
  );

  it.each(keptStopResolutions)(
    "does not let Keep $appliedSide resolve unrelated, completed or failed states",
    (resolution) => {
      for (const state of [
        "running",
        "awaiting_vote",
        "stopping",
        "discarding",
        "discarded",
        "complete",
        "creation_failed",
        "finalization_failed",
        "application_failed",
        "canonicalization_failed",
        "interrupted_recovery",
      ] as const) {
        expect(arenaResolutionStatus({ state, resolution })).toBeNull();
        expect(
          arenaResolutionStatus({ state, resolution, activeOperations: ["preserving_results"] }),
        ).toBeNull();
      }
    },
  );

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
