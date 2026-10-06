import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import { branchNameFromRef, type PickerItem } from "./new-workspace-picker-item";

/**
 * Why the typed name cannot become a branch. `slug` carries the daemon's own wording so the
 * picker rejects exactly what `checkout.create_branch` and the worktree workflow would.
 */
export type NewBranchNameError =
  | { kind: "empty" }
  | { kind: "trailing-slash" }
  | { kind: "slug"; message: string };

/**
 * The daemon's slug rules allow a trailing "/" that git then refuses, so the picker adds
 * that one rule rather than letting the create fail with a raw git error.
 */
export function validateNewBranchName(value: string): NewBranchNameError | null {
  const name = value.trim();
  if (name.length === 0) return { kind: "empty" };
  if (name.endsWith("/")) return { kind: "trailing-slash" };
  const validation = validateBranchSlug(name);
  if (!validation.valid) {
    return { kind: "slug", message: validation.error ?? "Invalid branch name" };
  }
  return null;
}

/**
 * The typed name's error as a dialog shows it under the field. Every surface that names a
 * branch reads the same rules, so they refuse the same names with the same wording.
 */
export function newBranchNameErrorMessage(
  value: string,
  t: (key: string) => string,
): string | null {
  const error = validateNewBranchName(value);
  if (!error) return null;
  switch (error.kind) {
    case "empty":
      return t("common.errors.nameRequired");
    case "trailing-slash":
      return t("newWorkspace.newBranch.errors.trailingSlash");
    case "slug":
      return error.message;
  }
}

/**
 * The ref a new branch is cut from. A branch row is its own base; anything else — a pull
 * request row, or nothing picked yet — falls back to the checkout's default base, because
 * neither carries a ref a branch can sit on.
 */
export function newBranchBaseItem(
  selected: PickerItem | null,
  fallback: PickerItem | null,
): Extract<PickerItem, { kind: "branch" }> | null {
  if (selected?.kind === "branch") return selected;
  if (fallback?.kind === "branch") return fallback;
  return null;
}

/** What the checkout answered about the base branch, from `validate_branch`. */
export interface NewBranchBaseProbe {
  exists: boolean;
  isRemote: boolean;
  error: string | null;
}

/**
 * The base the branch is cut from: an exact ref, or nothing left to cut from.
 */
export type NewBranchBase =
  | { kind: "ref"; refName: string }
  | { kind: "missing"; branchName: string };

/**
 * The ref a named branch is actually cut from.
 *
 * The picker defaults to the current branch's upstream, because detaching a worktree at the
 * pushed state keeps unpushed commits out of a workspace nobody asked to carry them into.
 * Naming a branch is the opposite intent: it says "start my work from where I am", so the
 * local ref wins and unpushed commits come along. A branch that exists only on the remote has
 * no local ref to prefer, so its own ref stands.
 *
 * Both isolation modes read this, and both carry the ref all the way to git rather than a
 * branch name resolved again later, so one picked row cannot mean two different commits.
 *
 * A probe that answered "no such branch" ends it here: the base the dialog named is gone, and
 * cutting from anywhere else would be inventing a base the user never picked. A probe that
 * could not answer at all leaves the picked ref alone — git resolves it and refuses if it has
 * to, which beats guessing from a failed read.
 */
export function resolveNewBranchBase(input: {
  baseRefName: string;
  probe: NewBranchBaseProbe | null;
}): NewBranchBase {
  const { baseRefName, probe } = input;
  const branchName = branchNameFromRef(baseRefName);
  if (probe && probe.error === null && !probe.exists) {
    return { kind: "missing", branchName };
  }
  const localBranchExists = probe?.exists === true && probe.isRemote === false;
  return { kind: "ref", refName: localBranchExists ? `refs/heads/${branchName}` : baseRefName };
}

/**
 * Whether the checkout is already sitting on the named branch, because Local mode cuts it the
 * moment the dialog is confirmed. Without this the deferred path would try to create a branch
 * that exists and, worse, switch back to the base first — undoing the checkout it just made.
 */
export function localBranchAlreadyCheckedOut(
  item: PickerItem | null,
  currentBranch: string | null | undefined,
): boolean {
  return item?.kind === "new-branch" && currentBranch === item.name;
}

export function newBranchPickerItem(input: {
  name: string;
  baseRefName: string;
}): Extract<PickerItem, { kind: "new-branch" }> {
  return { kind: "new-branch", name: input.name.trim(), baseRefName: input.baseRefName };
}

/** The base as it reads in the modal title and the picker row. */
export function newBranchBaseLabel(baseRefName: string): string {
  return branchNameFromRef(baseRefName);
}
