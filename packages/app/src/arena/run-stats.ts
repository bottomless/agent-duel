import { i18n } from "@/i18n/i18next";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaLongRunningTool, isArenaRunPossiblyStalled } from "./run-liveness";

/** The engine's retry status while a contestant waits for a new sign-in. */
export const ARENA_SIGN_IN_WAIT_MESSAGE = "Waiting for sign-in";

/** The engine's retry status while a contestant waits for the network. */
export const ARENA_NETWORK_WAIT_MESSAGE = "Waiting for network";

const RETRY_MESSAGES: Record<string, string> = {
  [ARENA_NETWORK_WAIT_MESSAGE]: "arena.waitingNetwork",
  [ARENA_SIGN_IN_WAIT_MESSAGE]: "arena.waitingSignIn",
  "Continuing after response limit": "arena.continuingLimit",
  "Continuing after model timeout": "arena.continuingTimeout",
};

type ArenaRunTiming = Pick<
  ArenaRun,
  "runState" | "startedAt" | "completedAt" | "durationMs" | "priorDurationMs"
>;

function parseTime(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How long a contestant has worked, or null before it starts.
 *
 * A settled run reports the engine's own duration so the number stops moving
 * the moment the run finalizes; a pending run counts from when it started.
 * Both include the requests before a follow-up or a retry, as the engine's
 * duration does.
 */
export function arenaRunElapsedMs(run: ArenaRunTiming, now: number): number | null {
  if (typeof run.durationMs === "number" && run.durationMs >= 0) return run.durationMs;
  const startedAt = arenaRunClockStart(run);
  if (startedAt === null) return null;
  const completedAt = parseTime(run.completedAt);
  if (completedAt !== null) return Math.max(0, completedAt - startedAt);
  if (run.runState !== "pending") return null;
  return Math.max(0, now - startedAt);
}

/**
 * When the run's clock would have started had it worked without a break: the
 * current request's start, moved back by the time worked before it.
 */
export function arenaRunClockStart(
  run: Pick<ArenaRun, "startedAt" | "priorDurationMs">,
): number | null {
  const startedAt = parseTime(run.startedAt);
  if (startedAt === null) return null;
  return startedAt - (run.priorDurationMs ?? 0);
}

export function arenaRunStatusLabel(run: ArenaRun, now: number): string {
  switch (run.runState) {
    case "pending":
      if (run.questions?.length) return i18n.t("arena.waitingAnswer");
      if (run.permissions?.length) return i18n.t("arena.permissionWait");
      if (
        typeof run.status === "object" &&
        run.status !== null &&
        "type" in run.status &&
        run.status.type === "retry"
      )
        // The engine's neutral recovery and offline-wait messages preserve blinding.
        return "message" in run.status &&
          typeof run.status.message === "string" &&
          Object.hasOwn(RETRY_MESSAGES, run.status.message)
          ? i18n.t(RETRY_MESSAGES[run.status.message])
          : i18n.t("arena.retryingStatus");
      switch (arenaLongRunningTool(run, now)) {
        case "command":
          return i18n.t("arena.runningCommand");
        case "tool":
          return i18n.t("arena.runningTool");
      }
      return isArenaRunPossiblyStalled(run, now)
        ? i18n.t("arena.noRecentActivity")
        : i18n.t("arena.workingStatus");
    case "complete":
      return i18n.t("arena.finished");
    case "stopped":
      return i18n.t("arena.stopped");
    case "interrupted":
      return i18n.t("arena.interrupted");
    case "error":
      return i18n.t("arena.failed");
  }
}

export function arenaRunFilesLabel(diff: ArenaRun["diff"]): string | null {
  if (!diff) return null;
  return i18n.t(diff.files === 1 ? "arena.oneFile" : "arena.fileCount", { total: diff.files });
}

/** The wait of a contestant whose session the app should recheck, if any. */
export function arenaRunAccountWait(
  run: Pick<ArenaRun, "runState" | "status">,
): "sign-in" | "network" | null {
  if (
    run.runState !== "pending" ||
    typeof run.status !== "object" ||
    run.status === null ||
    !("type" in run.status) ||
    run.status.type !== "retry" ||
    !("message" in run.status)
  ) {
    return null;
  }
  if (run.status.message === ARENA_SIGN_IN_WAIT_MESSAGE) return "sign-in";
  if (run.status.message === ARENA_NETWORK_WAIT_MESSAGE) return "network";
  return null;
}

/** Whether a contestant is waiting because the control plane refused the account session. */
export function arenaRunWaitsForSignIn(run: Pick<ArenaRun, "runState" | "status">): boolean {
  return arenaRunAccountWait(run) === "sign-in";
}
