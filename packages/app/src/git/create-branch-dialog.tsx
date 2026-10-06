import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { createBranchErrorMessage } from "@/git/create-branch-error";
import { newBranchNameErrorMessage } from "@/screens/new-workspace-new-branch";

interface GitCreateBranchTarget {
  serverId: string;
  cwd: string;
}

interface GitCreateBranchDialogState {
  target: GitCreateBranchTarget | null;
  open: (target: GitCreateBranchTarget) => void;
  close: () => void;
}

const useGitCreateBranchDialogStore = create<GitCreateBranchDialogState>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/**
 * The menu item that opens this sits in three surfaces — the workspace header, the Changes
 * pane, and the command center, which renders nothing at all — so the dialog cannot hang off
 * whichever one was clicked. The store carries the checkout; one host at the app root renders
 * the modal.
 */
export function openGitCreateBranchDialog(target: GitCreateBranchTarget): void {
  useGitCreateBranchDialogStore.getState().open(target);
}

export function GitCreateBranchDialogHost() {
  const { t } = useTranslation();
  const toast = useToast();
  const target = useGitCreateBranchDialogStore((state) => state.target);
  const close = useGitCreateBranchDialogStore((state) => state.close);
  const runCreateBranch = useCheckoutGitActionsStore((state) => state.createBranch);

  const validate = useCallback((value: string) => newBranchNameErrorMessage(value, t), [t]);

  // A rejection keeps the modal open with the message under the field, so a name git refuses
  // can be corrected where it was typed rather than read off a toast over a closed dialog.
  const handleSubmit = useCallback(
    async (value: string) => {
      if (!target) return;
      try {
        await runCreateBranch({ ...target, branch: value.trim() });
      } catch (error) {
        throw new Error(createBranchErrorMessage(error, t), { cause: error });
      }
      toast.show(t("workspace.git.actions.createBranch.success"), { variant: "success" });
    },
    [runCreateBranch, t, target, toast],
  );

  return (
    <AdaptiveRenameModal
      visible={target !== null}
      title={t("workspace.git.actions.createBranch.dialogTitle")}
      initialValue=""
      placeholder={t("workspace.git.actions.createBranch.placeholder")}
      submitLabel={t("workspace.git.actions.createBranch.submit")}
      validate={validate}
      onClose={close}
      onSubmit={handleSubmit}
      testID="git-create-branch-modal"
    />
  );
}
