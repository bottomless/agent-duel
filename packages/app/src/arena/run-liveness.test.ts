import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaLongRunningTool,
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
    canRetry: false,
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

describe("arenaLongRunningTool", () => {
  const now = Date.parse("2026-08-14T12:05:00.000Z");
  const fresh = new Date(now - 1_000).toISOString();
  const call = (name: string, input: unknown, ranMs: number) => ({
    type: "tool",
    tool: name,
    state: { status: "running", input, time: { start: now - ranMs } },
  });

  it("times a call from its own start, not from the run's last event", () => {
    const long = { step: [call("bash", { command: "sleep 130" }, POSSIBLY_STALLED_AFTER_MS)] };
    expect(arenaLongRunningTool(run({ lastEventAt: fresh, parts: long }), now)).toBe("command");
    const short = { step: [call("bash", { command: "ls" }, POSSIBLY_STALLED_AFTER_MS - 1)] };
    expect(arenaLongRunningTool(run({ lastEventAt: fresh, parts: short }), now)).toBeNull();
  });

  it("names only the calls that have run long while the run is active", () => {
    // A subagent's short command under a long task call must not flip the label back and forth.
    const parts = {
      root: [call("task", { prompt: "Audit the site" }, 120_000)],
      subagent: [call("bash", { command: "ls" }, 2_000)],
    };
    expect(arenaLongRunningTool(run({ lastEventAt: fresh, parts }), now)).toBe("tool");
  });

  it("names any running call once the whole run is quiet", () => {
    const quiet = new Date(now - POSSIBLY_STALLED_AFTER_MS).toISOString();
    const recent = { step: [call("bash", { command: "npm test" }, 30_000)] };
    expect(arenaLongRunningTool(run({ lastEventAt: quiet, parts: recent }), now)).toBe("command");
    const unstarted = { step: [{ type: "tool", tool: "read", state: { status: "running" } }] };
    expect(arenaLongRunningTool(run({ lastEventAt: quiet, parts: unstarted }), now)).toBe("tool");
    expect(arenaLongRunningTool(run({ lastEventAt: fresh, parts: unstarted }), now)).toBeNull();
    expect(arenaLongRunningTool(run({ lastEventAt: quiet }), now)).toBeNull();
  });
});
