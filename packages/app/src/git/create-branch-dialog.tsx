import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createBranchErrorMessage } from "@/git/create-branch-error";
import { newBranchNameErrorMessage } from "@/screens/new-workspace-new-branch";

interface GitCreateBranchTarget {
  serverId: string;
  cwd: string;
  /** The workspace whose chat title the suggested name starts from. */
  workspaceId?: string;
}

interface GitCreateBranchDialogState {
  target: GitCreateBranchTarget | null;
  /** Counts openings, so each one asks for a fresh suggestion. */
  openCount: number;
  open: (target: GitCreateBranchTarget) => void;
  close: () => void;
}

const useGitCreateBranchDialogStore = create<GitCreateBranchDialogState>()((set) => ({
  target: null,
  openCount: 0,
  open: (target) => set((state) => ({ target, openCount: state.openCount + 1 })),
  close: () => set({ target: null }),
}));

// The daemon writes the name on Arena's summary model from the chat title and the uncommitted
// changes, and the project's Branch names instructions. It is only an offer: the dialog opens
// empty, takes the name if nothing was typed yet, and stays empty when none comes.
function useBranchNameSuggestion(target: GitCreateBranchTarget | null, openCount: number) {
  const client = useHostRuntimeClient(target?.serverId ?? "");
  const query = useFetchQuery({
    queryKey: ["git-branch-name-suggestion", target?.serverId, target?.cwd, openCount],
    dataShape: "value",
    // One answer per opening: the next opening asks again under its own key, and a window
    // regaining focus does not write a second name over the first.
    staleTimeMs: 10 * 60_000,
    gcTime: 0,
    enabled: !!client && !!target,
    queryFn: async () => {
      if (!client || !target) return null;
      const result = await client.suggestBranchName({
        cwd: target.cwd,
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      });
      return result.branch;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return target ? (query.data ?? null) : null;
}

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
  const openCount = useGitCreateBranchDialogStore((state) => state.openCount);
  const close = useGitCreateBranchDialogStore((state) => state.close);
  const suggestion = useBranchNameSuggestion(target, openCount);
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
      suggestion={suggestion}
      placeholder={t("workspace.git.actions.createBranch.placeholder")}
      submitLabel={t("workspace.git.actions.createBranch.submit")}
      validate={validate}
      onClose={close}
      onSubmit={handleSubmit}
      testID="git-create-branch-modal"
    />
  );
}
