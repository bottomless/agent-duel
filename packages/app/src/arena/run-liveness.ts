import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { deriveArenaToolCallDetail } from "./tool-call-detail";

export const POSSIBLY_STALLED_AFTER_MS = 90_000;

export function isArenaRunPossiblyStalled(run: ArenaRun, now: number): boolean {
  if (run.runState !== "pending") return false;
  const activity = run.lastEventAt ?? run.firstEventAt ?? run.startedAt;
  if (typeof activity !== "string") return false;
  const activityAt = Date.parse(activity);
  return Number.isFinite(activityAt) && now - activityAt >= POSSIBLY_STALLED_AFTER_MS;
}

export type ArenaRunningTool = "command" | "tool";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tool call a pending run is still inside, if any. A long command emits no events until it
 * ends, which is why the engine pauses its own silence deadline while a tool runs; its quiet is
 * the command working, not the run stalling.
 */
export function arenaRunningTool(run: ArenaRun): ArenaRunningTool | null {
  if (run.runState !== "pending") return null;
  let running: ArenaRunningTool | null = null;
  for (const parts of Object.values(run.parts ?? {})) {
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue;
      if (part.state.status !== "running") continue;
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const detail = deriveArenaToolCallDetail(tool, part.state.input, part.state.output);
      if (detail?.type === "shell") return "command";
      running = "tool";
    }
  }
  return running;
}
