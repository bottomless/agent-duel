import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaRunningTool,
  isArenaRunPossiblyStalled,
  POSSIBLY_STALLED_AFTER_MS,
} from "./run-liveness";

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

describe("arenaRunningTool", () => {
  const tool = (name: string, status: string, input: unknown = {}) => ({
    type: "tool",
    tool: name,
    state: { status, input },
  });

  it("names a running shell command before any other running tool", () => {
    expect(
      arenaRunningTool(
        run({
          parts: {
            first: [tool("read", "running", { filePath: "README.md" })],
            second: [tool("bash", "running", { command: "npm run check" })],
          },
        }),
      ),
    ).toBe("command");
    expect(arenaRunningTool(run({ parts: { only: [tool("read", "running")] } }))).toBe("tool");
  });

  it("ignores finished tool calls and settled runs", () => {
    const parts = { done: [tool("bash", "completed", { command: "npm test" })] };
    expect(arenaRunningTool(run({ parts }))).toBeNull();
    expect(
      arenaRunningTool(
        run({
          runState: "complete",
          parts: { open: [tool("bash", "running", { command: "npm run check" })] },
        }),
      ),
    ).toBeNull();
  });
});
