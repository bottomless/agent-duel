import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { isArenaRunPossiblyStalled, POSSIBLY_STALLED_AFTER_MS } from "./run-liveness";

function run(input: Partial<ArenaRun> = {}): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/tmp/a",
    runState: "pending",
    durationMs: null,
    selectable: false,
    applicable: false,
    ...input,
    worktreeName: input.worktreeName ?? "a",
    worktreeActive: input.worktreeActive ?? true,
  };
}

describe("isArenaRunPossiblyStalled", () => {
  it("uses the most recent recorded provider activity", () => {
    const now = Date.parse("2026-08-14T12:02:00.000Z");
    expect(
      isArenaRunPossiblyStalled(
        run({
          startedAt: "2026-08-14T12:00:00.000Z",
          lastEventAt: new Date(now - POSSIBLY_STALLED_AFTER_MS + 1).toISOString(),
        }),
        now,
      ),
    ).toBe(false);
    expect(
      isArenaRunPossiblyStalled(
        run({ lastEventAt: new Date(now - POSSIBLY_STALLED_AFTER_MS).toISOString() }),
        now,
      ),
    ).toBe(true);
  });

  it("never labels a terminal provider run as stalled", () => {
    expect(
      isArenaRunPossiblyStalled(
        run({ runState: "complete", lastEventAt: "2026-08-14T12:00:00.000Z" }),
        Date.parse("2026-08-14T13:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
