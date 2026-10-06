import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  branchNameFromRef,
  pickerItemBaseRef,
  startsFromCurrentBranch,
  type PickerItem,
} from "./new-workspace-picker-item";
import { localBranchAlreadyCheckedOut } from "./new-workspace-new-branch";

type BranchClient = Pick<DaemonClient, "validateBranch" | "checkoutSwitchBranch" | "createBranch">;

export class MissingSelectedBranchError extends Error {}

export async function validateSelectedBranch(input: {
  client: Pick<BranchClient, "validateBranch">;
  cwd: string;
  item: PickerItem | null;
  missingBranchMessage: string;
}): Promise<void> {
  if (input.item?.kind !== "branch") return;
  const result = await input.client.validateBranch({
    cwd: input.cwd,
    branchName: branchNameFromRef(input.item.refName),
    refreshGit: true,
  });
  if (result.error) throw new Error(result.error);
  if (!result.exists) throw new MissingSelectedBranchError(input.missingBranchMessage);
}

/** Only an explicit pick moves a Local checkout. An unselected form follows Git. */
export async function prepareLocalCheckout(input: {
  client: BranchClient;
  cwd: string;
  item: PickerItem | null;
  currentBranch: string | null;
  switchFailedMessage: string;
  createFailedMessage: string;
  missingBranchMessage: string;
}): Promise<string | null> {
  const { client, cwd, item, currentBranch } = input;
  if (item?.kind === "new-branch" && localBranchAlreadyCheckedOut(item, currentBranch)) {
    return item.name;
  }
  const baseRef = pickerItemBaseRef(item);
  if (!baseRef) return currentBranch;

  // A branch named in Worktree mode may still be pending if the user then chooses Local.
  if (item?.kind === "new-branch") {
    const created = await client.createBranch({ cwd, branch: item.name, baseRef });
    if (!created.success) throw new Error(created.error?.message ?? input.createFailedMessage);
    return item.name;
  }

  await validateSelectedBranch(input);
  const branch = branchNameFromRef(baseRef);
  if (startsFromCurrentBranch(item, currentBranch)) return branch;
  try {
    const switched = await client.checkoutSwitchBranch(cwd, branch);
    if (!switched.success) throw new Error(switched.error?.message ?? input.switchFailedMessage);
  } catch (error) {
    // Deletion can race the validation. A failed read must not replace Git's useful
    // dirty-tree/conflict error with a claim that the branch was deleted.
    try {
      await validateSelectedBranch(input);
    } catch (validationError) {
      if (validationError instanceof MissingSelectedBranchError) throw validationError;
    }
    throw error;
  }
  return branch;
}
