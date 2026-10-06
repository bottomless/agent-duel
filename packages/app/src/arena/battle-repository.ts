import type { ProjectGitState } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { confirmDialog, type ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface BattleRepositoryClient {
  inspectProjectGit(cwd: string): Promise<{ state: ProjectGitState | null; error: string | null }>;
  initializeProjectGit(cwd: string): Promise<{ error: string | null }>;
}

/**
 * A battle freezes HEAD and cuts contestant worktrees from it, so a folder without a first
 * commit cannot host one. Ask before creating it: the commit lands in the user's history.
 * Resolves once the folder can host a battle and throws when it cannot, which keeps the
 * prompt in the composer.
 */
export async function ensureBattleRepository(input: {
  client: BattleRepositoryClient;
  cwd: string;
  confirm?: (dialog: ConfirmDialogInput) => Promise<boolean>;
}): Promise<void> {
  const inspected = await input.client.inspectProjectGit(input.cwd);
  if (inspected.state === null) {
    throw new Error(i18n.t("battleRepository.inspectFailed", { error: inspected.error ?? "" }));
  }
  if (inspected.state === "ready") return;

  const confirm = input.confirm ?? confirmDialog;
  const confirmed = await confirm({
    title: i18n.t("battleRepository.title"),
    message:
      inspected.state === "not_git"
        ? i18n.t("battleRepository.notGitMessage")
        : i18n.t("battleRepository.noCommitMessage"),
    confirmLabel: i18n.t("battleRepository.confirm"),
    cancelLabel: i18n.t("common.actions.cancel"),
  });
  if (!confirmed) throw new Error(i18n.t("battleRepository.declined"));

  const initialized = await input.client.initializeProjectGit(input.cwd);
  if (initialized.error !== null) {
    throw new Error(i18n.t("battleRepository.failed", { error: initialized.error }));
  }
}
