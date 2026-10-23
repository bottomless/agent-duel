import { describe, expect, it } from "vitest";

import {
  buildWorkspaceArchiveConfirmation,
  buildWorktreeArchiveConfirmationMessage,
  buildWorktreeArchiveRiskReasons,
  toWorktreeArchiveRisk,
} from "@/git/worktree-archive-warning";

describe("workspace archive warning for worktree backing", () => {
  it("does not require a confirmation for clean and pushed worktrees", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "feature",
        isDirty: false,
        aheadOfOrigin: 0,
        diffStat: null,
      }),
    ).toBeNull();
  });

  it("explains uncommitted line changes", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: true,
        aheadOfOrigin: 0,
        diffStat: { additions: 12, deletions: 1 },
      }),
    ).toEqual(["Uncommitted changes (12 added lines, 1 deleted line)"]);
  });

  it("treats nonzero diff stats as dirty when dirty state is missing", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: undefined,
        aheadOfOrigin: 0,
        diffStat: { additions: 4, deletions: 0 },
      }),
    ).toEqual(["Uncommitted changes (4 added lines)"]);
  });

  it("explains unpushed commits", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 2,
        diffStat: null,
      }),
    ).toEqual(["2 unpushed commits"]);
  });

  it("includes every archive risk in the confirmation copy", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "risky-feature",
        isDirty: true,
        aheadOfOrigin: 1,
        diffStat: { additions: 1, deletions: 3 },
      }),
    ).toBe("Uncommitted changes (1 added line, 3 deleted lines)\n1 unpushed commit");
  });

  it("maps archive workspace fields into the shared worktree risk shape", () => {
    expect(
      toWorktreeArchiveRisk({
        archiveHasUncommittedChanges: true,
        archiveUnpushedCommitCount: 3,
        diffStat: { additions: 2, deletions: 1 },
      }),
    ).toEqual({
      isDirty: true,
      aheadOfOrigin: 3,
      diffStat: { additions: 2, deletions: 1 },
    });
  });
});

describe("chat archive confirmation", () => {
  const clean = { isDirty: false, aheadOfOrigin: 0, diffStat: null };
  const risky = { isDirty: true, aheadOfOrigin: 1, diffStat: { additions: 1, deletions: 3 } };

  it("asks before archiving a clean chat", () => {
    expect(
      buildWorkspaceArchiveConfirmation({ workspaceName: "feature", isWorktree: true, ...clean }),
    ).toEqual({
      title: 'Archive "feature"?',
      message: "The chat moves to Archived, where you can unarchive it.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });

  it("lists a worktree's unsaved work under the message", () => {
    expect(
      buildWorkspaceArchiveConfirmation({ workspaceName: "feature", isWorktree: true, ...risky })
        .message,
    ).toBe(
      "The chat moves to Archived, where you can unarchive it.\n\n" +
        "Uncommitted changes (1 added line, 3 deleted lines)\n1 unpushed commit",
    );
  });

  it("leaves git state out for a chat that is not a worktree", () => {
    expect(
      buildWorkspaceArchiveConfirmation({ workspaceName: "feature", isWorktree: false, ...risky })
        .message,
    ).toBe("The chat moves to Archived, where you can unarchive it.");
  });
});
