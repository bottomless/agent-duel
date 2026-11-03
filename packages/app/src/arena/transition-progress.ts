import { i18n } from "@/i18n/i18next";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { isResolvingBattleState } from "./battle-result";

type Turn = NonNullable<ArenaSnapshot["turn"]>;
export type ArenaOperation = NonNullable<Turn["activeOperations"]>[number];
type ProgressTurn = Pick<Turn, "state" | "activeOperations" | "resolution">;

/**
 * What each engine step is called while it runs and once it is done. The status line and the
 * timeline both read it, and the status line keeps this order so overlapping work does not move.
 */
export const ARENA_OPERATION_LABELS: Record<
  ArenaOperation,
  { running: string; completed: string }
> = {
  preparing_workspaces: {
    get running() {
      return i18n.t("arena.prepareWorkspaces");
    },
    get completed() {
      return i18n.t("arena.preparedWorkspaces");
    },
  },
  copying_environment: {
    get running() {
      return i18n.t("arena.copyEnvironment");
    },
    get completed() {
      return i18n.t("arena.copiedEnvironment");
    },
  },
  checking_workspace: {
    get running() {
      return i18n.t("arena.checkWorkspace");
    },
    get completed() {
      return i18n.t("arena.checkedWorkspace");
    },
  },
  releasing_environment: {
    get running() {
      return i18n.t("arena.releasePrevious");
    },
    get completed() {
      return i18n.t("arena.releasedPrevious");
    },
  },
  preserving_results: {
    get running() {
      return i18n.t("arena.saveResults");
    },
    get completed() {
      return i18n.t("arena.savedResults");
    },
  },
  applying_changes: {
    get running() {
      return i18n.t("arena.applyChanges");
    },
    get completed() {
      return i18n.t("arena.appliedChanges");
    },
  },
  updating_conversation: {
    get running() {
      return i18n.t("arena.updateConversation");
    },
    get completed() {
      return i18n.t("arena.updatedConversation");
    },
  },
  releasing_loser: {
    get running() {
      return i18n.t("arena.releaseOther");
    },
    get completed() {
      return i18n.t("arena.releasedOther");
    },
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
  if (!turn) return i18n.t("arena.prepareWorkspaces");
  const preparing = turn.state === "creating" || turn.state === "worktrees_ready";
  if (!preparing && turn.state !== "running") return null;
  const operations = (turn.activeOperations ?? []).filter((operation) =>
    ARENA_SETUP_OPERATIONS.has(operation),
  );
  const active = operationStatus(operations);
  if (active) return active;
  if (turn.state === "creating") return i18n.t("arena.prepareWorkspaces");
  if (turn.state === "worktrees_ready") return i18n.t("arena.startingAgents");
  return null;
}

export function arenaResolutionStatus(turn: ProgressTurn | undefined): string | null {
  if (!turn) return null;
  const resolvingStoppedResult =
    turn.state === "awaiting_stop_resolution" &&
    turn.resolution?.kind === "stopped" &&
    turn.resolution.appliedSide !== undefined;
  if (!isResolvingBattleState(turn.state) && !resolvingStoppedResult) return null;
  const active = operationStatus(turn.activeOperations ?? []);
  if (active) return active;
  switch (turn.state) {
    case "early_selected":
      return i18n.t("arena.finishingOther");
    case "awaiting_stop_resolution":
    case "applying":
      return i18n.t("arena.prepareSelected");
    case "canonicalizing":
      return i18n.t("arena.finalizeConversation");
    default:
      return i18n.t("arena.prepareNext");
  }
}
