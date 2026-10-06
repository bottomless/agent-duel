import { z } from "zod";
import { ArenaBattleStateSchema, ArenaSideSchema } from "./rpc-schemas.js";

export const ArenaRunActivitySchema = z.object({
  id: z.string(),
  side: ArenaSideSchema,
  runState: z.enum(["pending", "complete", "stopped", "error", "interrupted"]),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  needsInput: z.boolean(),
  diff: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }).optional(),
});

export const ArenaSessionActivitySchema = z.object({
  sessionID: z.string(),
  chatID: z.string(),
  turnID: z.string().nullable().default(null),
  state: ArenaBattleStateSchema.nullable().default(null),
  resolved: z.boolean(),
  requiresDecision: z.boolean(),
  runs: z.array(ArenaRunActivitySchema),
  comparisonState: z.enum(["pending", "running", "complete", "skipped", "failed"]).optional(),
  summary: z.string().optional(),
  /**
   * What this chat changed on its own, across every applied turn.
   *
   * A workspace's `diffStat` belongs to its checkout, and chats started without a worktree share
   * one, so the same number reaches every workspace in it. This one is the chat's alone. Absent
   * until a turn has been applied, and the checkout's number stands in until then.
   */
  chatDiff: z
    .object({ files: z.number(), additions: z.number(), deletions: z.number() })
    .optional(),
});

export const ArenaActivitySchema = ArenaSessionActivitySchema.extend({
  agentId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  stale: z.boolean(),
});
export type ArenaSessionActivity = z.infer<typeof ArenaSessionActivitySchema>;
export type ArenaActivity = z.infer<typeof ArenaActivitySchema>;

export const ArenaActivitySubscribeRequestSchema = z.object({
  type: z.literal("arena.activity.subscribe.request"),
  requestId: z.string(),
});
export const ArenaActivitySubscribeResponseSchema = z.object({
  type: z.literal("arena.activity.subscribe.response"),
  payload: z.object({ requestId: z.string(), activities: z.array(ArenaActivitySchema) }),
});
export const ArenaActivityUpdateSchema = z.object({
  type: z.literal("arena.activity.update"),
  payload: z.object({
    activities: z.array(ArenaActivitySchema),
    removedAgentIds: z.array(z.string()),
  }),
});
export const ArenaNotificationSchema = z.object({
  type: z.literal("arena.notification"),
  payload: z.object({
    id: z.string(),
    kind: z.enum(["agent_finished", "battle_ready", "agent_error"]),
    agentId: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    body: z.string(),
  }),
});
export type ArenaNotification = z.infer<typeof ArenaNotificationSchema>["payload"];

export function arenaActivityStatus(activity: ArenaActivity) {
  if (activity.stale)
    return { bucket: "done", label: "Battle status unavailable", icon: "unknown" } as const;
  const state = activity.state;
  if (state === null) return { bucket: "done", label: "No active battle", icon: "idle" } as const;
  if (state.endsWith("_failed") || state === "interrupted_recovery") {
    return { bucket: "failed", label: "Battle needs attention", icon: "alert" } as const;
  }
  if (activity.resolved) {
    if (state === "complete" || state === "discarded") {
      return { bucket: "done", label: "Battle complete", icon: "idle" } as const;
    }
    // A durable vote ends the navigation's busy state; the battle card owns application progress.
    return { bucket: "done", label: "Applying selection", icon: "idle" } as const;
  }
  if (state === "awaiting_stop_resolution") {
    return {
      bucket: "needs_input",
      label: "Stopped battle needs a decision",
      icon: "alert",
    } as const;
  }
  if (activity.runs.some((run) => run.needsInput)) {
    return { bucket: "needs_input", label: "Agent needs your input", icon: "alert" } as const;
  }
  if (activity.runs.some((run) => run.runState === "error" || run.runState === "interrupted")) {
    return { bucket: "failed", label: "Agent needs attention", icon: "alert" } as const;
  }
  if (activity.requiresDecision) {
    return { bucket: "attention", label: "Ready to choose", icon: "ready" } as const;
  }
  if (state === "complete" || state === "discarded") {
    return { bucket: "done", label: "Battle complete", icon: "idle" } as const;
  }
  if (state === "stopping" || state === "discarding") {
    return { bucket: "running", label: "Stopping battle", icon: "running" } as const;
  }
  if (state === "creating" || state === "worktrees_ready") {
    return { bucket: "running", label: "Preparing agents", icon: "running" } as const;
  }
  return arenaRunStatus(activity);
}

function arenaRunStatus(activity: ArenaActivity) {
  const finished = activity.runs.find((run) => run.runState === "complete");
  const pending = activity.runs.find((run) => run.runState === "pending");
  if (finished && pending) {
    return {
      bucket: "running",
      label: `Agent ${finished.side.toUpperCase()} finished; Agent ${pending.side.toUpperCase()} is working`,
      icon: "running",
    } as const;
  }
  if (!pending && activity.runs.length === 2) {
    return { bucket: "running", label: "Preparing results", icon: "running" } as const;
  }
  return { bucket: "running", label: "Agents are working", icon: "running" } as const;
}
