import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { POSSIBLY_STALLED_AFTER_MS } from "./run-liveness";
import { arenaRunElapsedMs, arenaRunFilesLabel, arenaRunStatusLabel } from "./run-stats";

const NOW = Date.parse("2026-09-03T10:05:00.000Z");
const STARTED_AT = "2026-09-03T10:00:00.000Z";

function run(input: Partial<ArenaRun> = {}): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    worktreeName: "a",
    worktreeActive: true,
    runState: "pending",
    durationMs: null,
    selectable: false,
    applicable: false,
    ...input,
  };
}

describe("arenaRunElapsedMs", () => {
  it("prefers the engine's duration once a run has settled", () => {
    expect(
      arenaRunElapsedMs(
        run({ runState: "complete", startedAt: STARTED_AT, durationMs: 42_000 }),
        NOW,
      ),
    ).toBe(42_000);
  });

  it("falls back to the completion timestamps without a duration", () => {
    expect(
      arenaRunElapsedMs(
        run({
          runState: "complete",
          startedAt: STARTED_AT,
          completedAt: "2026-09-03T10:02:30.000Z",
        }),
        NOW,
      ),
    ).toBe(150_000);
  });

  it("counts live from the start while the run is pending", () => {
    expect(arenaRunElapsedMs(run({ startedAt: STARTED_AT }), NOW)).toBe(300_000);
  });

  it("reports nothing before a run starts or for a settled run with no timing", () => {
    expect(arenaRunElapsedMs(run(), NOW)).toBeNull();
    expect(arenaRunElapsedMs(run({ runState: "error", startedAt: STARTED_AT }), NOW)).toBeNull();
  });
});

describe("arenaRunStatusLabel", () => {
  it("names each terminal state", () => {
    expect(
      arenaRunStatusLabel(run({ runState: "pending", startedAt: STARTED_AT }), NOW - 299_000),
    ).toBe("Working");
    expect(arenaRunStatusLabel(run({ runState: "complete" }), NOW)).toBe("Finished");
    expect(arenaRunStatusLabel(run({ runState: "stopped" }), NOW)).toBe("Stopped");
    expect(arenaRunStatusLabel(run({ runState: "interrupted" }), NOW)).toBe("Interrupted");
    expect(arenaRunStatusLabel(run({ runState: "error" }), NOW)).toBe("Failed");
  });

  it("names the required user action instead of reporting a waiting run as stalled", () => {
    const quiet = { startedAt: STARTED_AT, lastEventAt: STARTED_AT };
    expect(arenaRunStatusLabel(run({ ...quiet, questions: [{ id: "q1" }] }), NOW)).toBe(
      "Waiting for your answer",
    );
    expect(arenaRunStatusLabel(run({ ...quiet, permissions: [{ id: "p1" }] }), NOW)).toBe(
      "Waiting for permission",
    );
    expect(
      arenaRunStatusLabel(run({ ...quiet, questions: [{ id: "q1" }], runState: "complete" }), NOW),
    ).toBe("Finished");
  });

  it("describes silence without claiming the agent is stalled", () => {
    const quiet = run({ runState: "pending", startedAt: STARTED_AT, lastEventAt: STARTED_AT });
    expect(arenaRunStatusLabel(quiet, Date.parse(STARTED_AT) + POSSIBLY_STALLED_AFTER_MS)).toBe(
      "No recent activity",
    );
  });

  it("shows retry before the silence warning", () => {
    const quiet = run({ startedAt: STARTED_AT, lastEventAt: STARTED_AT });
    expect(
      arenaRunStatusLabel({ ...quiet, status: { type: "retry", next: NOW + 5_000 } }, NOW),
    ).toBe("Retrying");
    expect(
      arenaRunStatusLabel({ ...quiet, status: { type: "retry" }, questions: [{ id: "q1" }] }, NOW),
    ).toBe("Waiting for your answer");
  });

  it("lets terminal states override stale waits and restores Working on new activity", () => {
    const waiting = run({ status: { type: "retry" }, questions: [{}], lastEventAt: STARTED_AT });
    expect(arenaRunStatusLabel({ ...waiting, runState: "error" }, NOW)).toBe("Failed");
    expect(arenaRunStatusLabel({ ...waiting, runState: "complete" }, NOW)).toBe("Finished");
    expect(arenaRunStatusLabel(run({ lastEventAt: new Date(NOW).toISOString() }), NOW)).toBe(
      "Working",
    );
  });
});

describe("arenaRunFilesLabel", () => {
  it("pluralizes the changed file count", () => {
    expect(arenaRunFilesLabel({ files: 1, additions: 3, deletions: 0 })).toBe("1 file");
    expect(arenaRunFilesLabel({ files: 3, additions: 3, deletions: 0 })).toBe("3 files");
    expect(arenaRunFilesLabel(undefined)).toBeNull();
  });
});
