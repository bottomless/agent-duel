import { describe, expect, test } from "vitest";
import { resolveForkWorkspaceCreationTarget } from "./fork-workspace";

describe("current worktree fork workspace", () => {
  test("creates another workspace backed by the agent cwd", () => {
    expect(
      resolveForkWorkspaceCreationTarget(
        {
          cwd: "  /repo/current-worktree  ",
          projectPlacement: {
            checkout: { cwd: "/repo/project-root", isGit: true, currentBranch: "main" },
          },
        },
        { title: "Fix the composer (2)", fallbackBranch: "unused-branch" },
        "current_worktree",
      ),
    ).toEqual({ kind: "directory", path: "/repo/current-worktree" });
  });

  test("requires a source cwd", () => {
    expect(
      resolveForkWorkspaceCreationTarget(
        { cwd: "   " },
        { title: "Fix the composer (2)", fallbackBranch: "unused-branch" },
        "current_worktree",
      ),
    ).toBeNull();
  });
});

test("creates a branch-off worktree from the source branch", () => {
  expect(
    resolveForkWorkspaceCreationTarget(
      {
        cwd: "/repo/feature",
        projectPlacement: {
          checkout: {
            cwd: "/repo/feature",
            isGit: true,
            currentBranch: "feature/source",
          },
        },
      },
      { title: "Fix the composer (2)", fallbackBranch: "quiet-river" },
    ),
  ).toEqual({
    kind: "worktree",
    cwd: "/repo/feature",
    worktree: {
      mode: "branch-off",
      newBranch: "fix-the-composer-2",
      workspaceTitle: "Fix the composer (2)",
      base: "feature/source",
    },
  });
});

describe("non-git fork workspace", () => {
  test("creates another workspace backed by the source directory", () => {
    expect(
      resolveForkWorkspaceCreationTarget(
        {
          cwd: "/notes",
          projectPlacement: { checkout: { cwd: "/notes", isGit: false } },
        },
        { title: "Notes (2)", fallbackBranch: "unused-branch" },
      ),
    ).toEqual({ kind: "directory", path: "/notes" });
  });
});

test("requires a resolved source checkout", () => {
  expect(
    resolveForkWorkspaceCreationTarget(
      { cwd: "/repo" },
      { title: "Fix the composer (2)", fallbackBranch: "quiet-river" },
    ),
  ).toBeNull();
});

test("falls back to a generated branch when the title cannot form a Git slug", () => {
  expect(
    resolveForkWorkspaceCreationTarget(
      {
        cwd: "/repo",
        projectPlacement: { checkout: { cwd: "/repo", isGit: true } },
      },
      { title: "日本語", fallbackBranch: "quiet-river" },
    ),
  ).toMatchObject({
    worktree: { newBranch: "quiet-river", workspaceTitle: "日本語" },
  });
});
