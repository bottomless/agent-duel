import { describe, expect, it } from "vitest";
import { transitionDuration, transitionTimelineRows } from "./transition-timeline-state";

describe("battle transition timeline", () => {
  it("retains finished setup steps beside the copy still running", () => {
    expect(
      transitionTimelineRows({
        phase: "setup",
        turn: {
          state: "running",
          operationProgress: [
            {
              operation: "preparing_workspaces",
              state: "completed",
              startedAt: 1000,
              finishedAt: 1600,
            },
            { operation: "copying_environment", state: "running", startedAt: 1700 },
          ],
        },
      }),
    ).toEqual([
      {
        id: "preparing_workspaces",
        label: "Workspaces prepared",
        state: "completed",
        startedAt: 1000,
        finishedAt: 1600,
      },
      {
        id: "copying_environment",
        label: "Copying files and dependencies",
        state: "running",
        startedAt: 1700,
        finishedAt: null,
      },
      { id: "ready", label: "Agents ready", state: "waiting", startedAt: null, finishedAt: null },
    ]);
  });

  it("shows overlapping application steps without replaying setup", () => {
    expect(
      transitionTimelineRows({
        phase: "resolution",
        turn: {
          state: "applying",
          operationProgress: [
            {
              operation: "preparing_workspaces",
              state: "completed",
              startedAt: 1000,
              finishedAt: 1600,
            },
            {
              operation: "preserving_results",
              state: "completed",
              startedAt: 2000,
              finishedAt: 2400,
            },
            { operation: "updating_conversation", state: "running", startedAt: 2500 },
            { operation: "applying_changes", state: "running", startedAt: 2700 },
          ],
        },
      }),
    ).toEqual([
      {
        id: "preserving_results",
        label: "Battle results saved",
        state: "completed",
        startedAt: 2000,
        finishedAt: 2400,
      },
      {
        id: "updating_conversation",
        label: "Updating the conversation",
        state: "running",
        startedAt: 2500,
        finishedAt: null,
      },
      {
        id: "applying_changes",
        label: "Applying changes to your workspace",
        state: "running",
        startedAt: 2700,
        finishedAt: null,
      },
      {
        id: "ready",
        label: "Ready for your next prompt",
        state: "waiting",
        startedAt: null,
        finishedAt: null,
      },
    ]);
  });

  it("never treats failed or interrupted work as completed", () => {
    const rows = transitionTimelineRows({
      phase: "resolution",
      turn: {
        state: "application_failed",
        operationProgress: [
          { operation: "applying_changes", state: "failed", startedAt: 1000, finishedAt: 1600 },
          {
            operation: "updating_conversation",
            state: "interrupted",
            startedAt: 1200,
            finishedAt: 1700,
          },
        ],
      },
    });
    expect(rows.map(({ state }) => state)).toEqual(["failed", "interrupted", "waiting"]);
  });

  it("starts immediately without inventing completed steps or timestamps", () => {
    expect(transitionTimelineRows({ phase: "setup", turn: undefined })).toEqual([
      {
        id: "starting",
        label: "Preparing workspaces",
        state: "running",
        startedAt: null,
        finishedAt: null,
      },
      { id: "ready", label: "Agents ready", state: "waiting", startedAt: null, finishedAt: null },
    ]);
  });

  it("formats recorded durations and tolerates a small clock offset", () => {
    expect([
      transitionDuration(-5),
      transitionDuration(900),
      transitionDuration(2300),
      transitionDuration(62400),
    ]).toEqual(["<1s", "<1s", "2s", "1m 2s"]);
  });
});
