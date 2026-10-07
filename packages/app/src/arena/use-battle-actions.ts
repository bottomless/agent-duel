import { useCallback, useMemo } from "react";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type {
  ArenaReviewAnswer,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { DISCARD_WINNER_CONFIRMATION } from "./review";
import { EARLY_BATTLE_TOAST } from "./constants";
import type { ArenaPendingPermission, ArenaPermissionReply } from "./permission";
import { arenaQuestionAnswers, type ArenaPendingQuestion } from "./question";
import {
  useArenaTurnMutation,
  useArenaTurnPending,
  useArenaTurnFeedback,
  type ArenaTurnAction,
} from "./use-arena-session";

export type ArenaStopResolution = "discard" | "apply_a" | "apply_b";

function sideLabel(side: ArenaSide): string {
  return side.toUpperCase();
}

/**
 * The one home for everything a voter can do to a battle turn.
 *
 * The battle card (question and permission replies, summary retry) and the
 * decision bar (votes, stop, keep or discard, resolution retry) each call
 * this. `pending` is read from the shared mutation key rather than this
 * instance, so the two surfaces disable together.
 */
export function useArenaBattleActions(
  serverId: string,
  agentId: string,
  turn: ArenaSnapshot["turn"],
) {
  const toast = useToast();
  const mutation = useArenaTurnMutation(serverId, agentId);
  const pending = useArenaTurnPending(serverId, agentId);
  const mutateTurn = mutation.mutateAsync;
  const feedback = useArenaTurnFeedback(serverId, agentId);
  const pendingAction: ArenaTurnAction | null =
    feedback?.status === "pending" ? (feedback.action ?? null) : null;
  const belongsToTurn =
    !turn?.createdAt || (feedback?.submittedAt ?? 0) >= Date.parse(turn.createdAt);
  const errorBelongsToBattle =
    belongsToTurn &&
    feedback?.action?.kind !== "interrupt_steer" &&
    feedback?.action?.kind !== "discard_steer";
  const actionError =
    errorBelongsToBattle && feedback?.status === "error" ? toErrorMessage(feedback.error) : null;
  const turnId = turn?.id;
  const turnState = turn?.state;

  const showError = useCallback(
    (error: unknown) => {
      toast.error(toErrorMessage(error));
    },
    [toast],
  );

  const choose = useCallback(
    async (side: ArenaSide) => {
      if (!turnId) return;
      const early = turnState === "running";
      try {
        await mutateTurn({ kind: "vote", turnId, vote: side });
        if (early) {
          toast.show(EARLY_BATTLE_TOAST, { variant: "info", durationMs: 4_000 });
        }
      } catch (error) {
        showError(error);
      }
    },
    [mutateTurn, showError, toast, turnId, turnState],
  );

  // An early pick cancels the other side, so it asks first; the losing work
  // is gone the moment the vote lands.
  const pickEarly = useCallback(
    async (side: ArenaSide) => {
      const label = sideLabel(side);
      const other = sideLabel(side === "a" ? "b" : "a");
      const confirmed = await confirmDialog({
        title: `Choose ${label} now?`,
        message: `Agent ${other} stops immediately and its work is discarded. Agent ${label}'s work so far becomes this turn's result.`,
        confirmLabel: `Choose ${label}`,
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;
      await choose(side);
    },
    [choose],
  );

  const tie = useCallback(async () => {
    if (!turnId) return;
    try {
      await mutateTurn({ kind: "vote", turnId, vote: "tie" });
    } catch (error) {
      showError(error);
    }
  }, [mutateTurn, showError, turnId]);

  const stop = useCallback(async () => {
    if (!turnId) return;
    try {
      await mutateTurn({ kind: "stop", turnId });
    } catch (error) {
      showError(error);
    }
  }, [mutateTurn, showError, turnId]);

  const resolveStop = useCallback(
    async (resolution: ArenaStopResolution) => {
      if (!turnId) return;
      if (resolution === "discard") {
        const confirmed = await confirmDialog({
          title: "Discard this battle?",
          message:
            "Both agents' work from this turn will be discarded. Your previous chat history and project stay unchanged.",
          confirmLabel: "Discard battle",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (!confirmed) return;
      }
      try {
        await mutateTurn({ kind: "resolve_stop", turnId, resolution });
      } catch (error) {
        showError(error);
      }
    },
    [mutateTurn, showError, turnId],
  );

  const retryResolution = useCallback(() => {
    if (!turnId) return;
    void mutateTurn({ kind: "retry_resolution", turnId }).catch(showError);
  }, [mutateTurn, showError, turnId]);

  // The review's answers go back through the same retry; the daemon plans again with them.
  // Resolves true once the daemon applied what it could, so a prompt that depends on it can follow.
  const answerReview = useCallback(
    async (answers: readonly ArenaReviewAnswer[]) => {
      if (!turnId) return false;
      try {
        await mutateTurn({ kind: "retry_resolution", turnId, answers });
        return true;
      } catch (error) {
        showError(error);
        return false;
      }
    },
    [mutateTurn, showError, turnId],
  );

  const discardWinner = useCallback(async () => {
    if (!turnId) return;
    try {
      if (!(await confirmDialog(DISCARD_WINNER_CONFIRMATION))) return;
      await mutateTurn({ kind: "retry_resolution", turnId, mode: "discard_winner" });
    } catch (error) {
      showError(error);
    }
  }, [mutateTurn, showError, turnId]);

  // Puts back a workspace an apply left half written. The daemon runs nothing else with it.
  const restoreWorkspace = useCallback(() => {
    if (!turnId) return;
    void mutateTurn({ kind: "retry_resolution", turnId, mode: "restore_workspace" }).catch(
      showError,
    );
  }, [mutateTurn, showError, turnId]);

  const retryComparison = useCallback(() => {
    if (!turnId) return;
    void mutateTurn({ kind: "retry_comparison", turnId }).catch(showError);
  }, [mutateTurn, showError, turnId]);

  const replyQuestion = useCallback(
    (run: ArenaRun, question: ArenaPendingQuestion, response: AgentPermissionResponse) => {
      const answers = arenaQuestionAnswers(question, response);
      const action: ArenaTurnAction = answers
        ? { kind: "reply_question", runId: run.id, questionRequestId: question.id, answers }
        : { kind: "reject_question", runId: run.id, questionRequestId: question.id };
      void mutateTurn(action).catch(showError);
    },
    [mutateTurn, showError],
  );

  const replyPermission = useCallback(
    (run: ArenaRun, permission: ArenaPendingPermission, response: ArenaPermissionReply) => {
      void mutateTurn({
        kind: "reply_permission",
        runId: run.id,
        permissionRequestId: permission.id,
        response,
      }).catch(showError);
    },
    [mutateTurn, showError],
  );

  return useMemo(
    () => ({
      pending,
      pendingAction,
      actionError,
      choose,
      pickEarly,
      tie,
      stop,
      resolveStop,
      retryResolution,
      answerReview,
      discardWinner,
      restoreWorkspace,
      retryComparison,
      replyQuestion,
      replyPermission,
    }),
    [
      choose,
      actionError,
      pending,
      pendingAction,
      pickEarly,
      replyPermission,
      replyQuestion,
      answerReview,
      discardWinner,
      restoreWorkspace,
      resolveStop,
      retryComparison,
      retryResolution,
      stop,
      tie,
    ],
  );
}

export type ArenaBattleActions = ReturnType<typeof useArenaBattleActions>;
