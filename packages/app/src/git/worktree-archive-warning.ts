import { confirmDialog, type ConfirmDialogInput } from "@/utils/confirm-dialog";
import { i18n } from "@/i18n/i18next";

export interface WorktreeArchiveRisk {
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
}

export interface WorktreeArchiveRiskInput {
  archiveHasUncommittedChanges?: boolean | null;
  archiveUnpushedCommitCount?: number | null;
  diffStat?: WorktreeArchiveRisk["diffStat"];
}

export interface WorktreeArchiveConfirmationInput extends WorktreeArchiveRisk {
  workspaceName: string;
}

export interface WorktreeArchiveWarningLabels {
  title: (workspaceName: string) => string;
  confirm: string;
  cancel: string;
  message: string;
  uncommittedChanges: string;
  uncommittedChangesWithDiff: (diffStat: string) => string;
  addedLine: (count: number) => string;
  deletedLine: (count: number) => string;
  unpushedCommit: (count: number) => string;
  workSaved: string;
}

// Getters, not values: the labels are read when a dialog opens, after the app language is known.
export const DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS: WorktreeArchiveWarningLabels = {
  title: (workspaceName) => i18n.t("workspace.git.actions.archiveWarning.title", { workspaceName }),
  get confirm() {
    return i18n.t("workspace.git.actions.archiveWarning.confirm");
  },
  get cancel() {
    return i18n.t("workspace.git.actions.archiveWarning.cancel");
  },
  get message() {
    return i18n.t("workspace.git.actions.archiveWarning.message");
  },
  get uncommittedChanges() {
    return i18n.t("workspace.git.actions.archiveWarning.uncommittedChanges");
  },
  uncommittedChangesWithDiff: (diffStat) =>
    i18n.t("workspace.git.actions.archiveWarning.uncommittedChangesWithDiff", { diffStat }),
  addedLine: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.addedLine", { count })
      : i18n.t("workspace.git.actions.archiveWarning.addedLines", { count }),
  deletedLine: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.deletedLine", { count })
      : i18n.t("workspace.git.actions.archiveWarning.deletedLines", { count }),
  unpushedCommit: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.unpushedCommit", { count })
      : i18n.t("workspace.git.actions.archiveWarning.unpushedCommits", { count }),
  get workSaved() {
    return i18n.t("workspace.git.actions.archiveWarning.workSaved");
  },
};

export function toWorktreeArchiveRisk(input: WorktreeArchiveRiskInput): WorktreeArchiveRisk {
  return {
    isDirty: input.archiveHasUncommittedChanges,
    aheadOfOrigin: input.archiveUnpushedCommitCount,
    diffStat: input.diffStat,
  };
}

function formatDiffStat(
  diffStat: WorktreeArchiveRisk["diffStat"],
  labels: WorktreeArchiveWarningLabels,
): string | null {
  if (!diffStat) {
    return null;
  }

  const parts: string[] = [];
  if (diffStat.additions > 0) {
    parts.push(labels.addedLine(diffStat.additions));
  }
  if (diffStat.deletions > 0) {
    parts.push(labels.deletedLine(diffStat.deletions));
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

export function buildWorktreeArchiveRiskReasons(
  input: WorktreeArchiveRisk,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): string[] {
  const reasons: string[] = [];
  const diffStat = input.diffStat;
  const hasDiffStatChanges = diffStat ? diffStat.additions > 0 || diffStat.deletions > 0 : false;
  const hasUncommittedChanges =
    input.isDirty === true || (input.isDirty == null && hasDiffStatChanges);

  if (hasUncommittedChanges) {
    const diffStatLabel = formatDiffStat(diffStat, labels);
    reasons.push(
      diffStatLabel ? labels.uncommittedChangesWithDiff(diffStatLabel) : labels.uncommittedChanges,
    );
  }

  if ((input.aheadOfOrigin ?? 0) > 0) {
    const aheadOfOrigin = input.aheadOfOrigin ?? 0;
    reasons.push(labels.unpushedCommit(aheadOfOrigin));
  }

  return reasons;
}

export function buildWorktreeArchiveConfirmationMessage(
  input: WorktreeArchiveConfirmationInput,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): string | null {
  const reasons = buildWorktreeArchiveRiskReasons(input, labels);
  if (reasons.length === 0) {
    return null;
  }

  return reasons.join("\n");
}

export async function confirmRiskyWorktreeArchive(
  input: WorktreeArchiveConfirmationInput,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): Promise<boolean> {
  const message = buildWorktreeArchiveConfirmationMessage(input, labels);
  if (!message) {
    return true;
  }

  return await confirmDialog({
    title: labels.title(input.workspaceName),
    message,
    confirmLabel: labels.confirm,
    cancelLabel: labels.cancel,
    destructive: true,
  });
}

export interface WorkspaceArchiveConfirmationInput extends WorktreeArchiveConfirmationInput {
  isWorktree: boolean;
  /** Archive saves the worktree's work for Restore (an Arena New worktree). */
  keepsWork?: boolean;
}

/** Archiving one chat always asks; a worktree's unsaved work is listed under the message. */
export function buildWorkspaceArchiveConfirmation(
  input: WorkspaceArchiveConfirmationInput,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): ConfirmDialogInput {
  const risks = input.isWorktree ? buildWorktreeArchiveConfirmationMessage(input, labels) : null;
  const details = risks && input.keepsWork ? `${risks}\n${labels.workSaved}` : risks;
  return {
    title: labels.title(input.workspaceName),
    message: details ? `${labels.message}\n\n${details}` : labels.message,
    confirmLabel: labels.confirm,
    cancelLabel: labels.cancel,
    destructive: true,
  };
}
