import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { isResolvingBattleState } from "./battle-result";

type Turn = NonNullable<ArenaSnapshot["turn"]>;
export type ArenaOperation = NonNullable<Turn["activeOperations"]>[number];
type ProgressTurn = Pick<Turn, "state" | "activeOperations">;

/**
 * What each engine step is called while it runs and once it is done. The status line and the
 * timeline both read it, and the status line keeps this order so overlapping work does not move.
 */
export const ARENA_OPERATION_LABELS: Record<
  ArenaOperation,
  { running: string; completed: string }
> = {
  preparing_workspaces: { running: "Preparing workspaces", completed: "Workspaces prepared" },
  copying_environment: {
    running: "Copying files and dependencies",
    completed: "Files and dependencies copied",
  },
  checking_workspace: {
    running: "Checking workspace changes",
    completed: "Workspace changes checked",
  },
  releasing_environment: {
    running: "Releasing the previous environment",
    completed: "Previous environment released",
  },
  preserving_results: { running: "Saving battle results", completed: "Battle results saved" },
  applying_changes: {
    running: "Applying changes to your workspace",
    completed: "Changes applied to your workspace",
  },
  updating_conversation: {
    running: "Updating the conversation",
    completed: "Conversation updated",
  },
  releasing_loser: {
    running: "Releasing the other environment",
    completed: "Other environment released",
  },
};

/** The steps of setting up a battle; every other step applies its result. */
export const ARENA_SETUP_OPERATIONS: ReadonlySet<ArenaOperation> = new Set<ArenaOperation>([
  "preparing_workspaces",
  "copying_environment",
  "releasing_environment",
]);

function operationStatus(operations: readonly ArenaOperation[]): string | null {
  if (operations.length === 0) return null;
  return Object.entries(ARENA_OPERATION_LABELS)
    .filter(([operation]) => operations.some((active) => active === operation))
    .map(([, label]) => label.running)
    .join(" · ");
}

export function arenaSetupStatus(turn: ProgressTurn | undefined): string | null {
  if (!turn) return "Preparing workspaces";
  const preparing = turn.state === "creating" || turn.state === "worktrees_ready";
  if (!preparing && turn.state !== "running") return null;
  const operations = (turn.activeOperations ?? []).filter((operation) =>
    ARENA_SETUP_OPERATIONS.has(operation),
  );
  const active = operationStatus(operations);
  if (active) return active;
  if (turn.state === "creating") return "Preparing workspaces";
  if (turn.state === "worktrees_ready") return "Starting agents";
  return null;
}

export function arenaResolutionStatus(turn: ProgressTurn | undefined): string | null {
  if (!turn || !isResolvingBattleState(turn.state)) return null;
  const active = operationStatus(turn.activeOperations ?? []);
  if (active) return active;
  switch (turn.state) {
    case "early_selected":
      return "Finishing the other agent's run";
    case "applying":
      return "Preparing the selected result";
    case "canonicalizing":
      return "Finalizing the conversation";
    default:
      return "Preparing the next turn";
  }
}
