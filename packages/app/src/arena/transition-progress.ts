import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { isResolvingBattleState } from "./battle-result";

type Turn = NonNullable<ArenaSnapshot["turn"]>;
type Operation = NonNullable<Turn["activeOperations"]>[number];
type ProgressTurn = Pick<Turn, "state" | "activeOperations">;

const OPERATION_LABELS: Record<Operation, string> = {
  preparing_workspaces: "Preparing workspaces",
  copying_environment: "Copying project files and dependencies",
  checking_workspace: "Checking workspace changes",
  releasing_environment: "Releasing the previous environment",
  preserving_results: "Saving battle results",
  applying_changes: "Applying changes to your workspace",
  updating_conversation: "Updating the conversation",
  releasing_loser: "Releasing the other agent's environment",
};

const SETUP_OPERATIONS = new Set<Operation>([
  "preparing_workspaces",
  "copying_environment",
  "releasing_environment",
]);

function operationStatus(operations: readonly Operation[]): string | null {
  if (operations.length === 0) return null;
  // Stable ordering keeps overlapping work from rearranging the status line.
  const ordered = Object.entries(OPERATION_LABELS);
  return ordered
    .filter(([operation]) => operations.some((active) => active === operation))
    .map(([, label]) => label)
    .join(" · ");
}

export function arenaSetupStatus(turn: ProgressTurn | undefined): string | null {
  if (!turn) return "Preparing workspaces";
  const preparing = turn.state === "creating" || turn.state === "worktrees_ready";
  if (!preparing && turn.state !== "running") return null;
  const operations = (turn.activeOperations ?? []).filter((operation) =>
    SETUP_OPERATIONS.has(operation),
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
