import { describe, expect, it } from "vitest";
import { arenaReplyFiles, retargetWorktreePaths } from "./reply-files";

const worktree = "/repo/.agent-duel/worktrees/chat/generation-1-a";

describe("arenaReplyFiles", () => {
  it("reads from the worktree while it exists", () => {
    expect(arenaReplyFiles({ worktree, worktreeActive: true }, true)).toEqual({
      kind: "worktree",
      root: worktree,
    });
  });

  it("moves the applied side to the workspace and drops the other", () => {
    expect(arenaReplyFiles({ worktree, worktreeActive: false }, true)).toEqual({
      kind: "applied",
      worktree,
    });
    expect(arenaReplyFiles({ worktree, worktreeActive: false }, false)).toEqual({
      kind: "removed",
      worktree,
    });
  });
});

describe("retargetWorktreePaths", () => {
  it("rewrites absolute paths and file URLs into the worktree", () => {
    const text = `![a](${worktree}/shot.png) [b](file://${worktree}/notes.md:2) ${worktree}`;
    expect(retargetWorktreePaths(text, worktree, "/repo")).toBe(
      "![a](/repo/shot.png) [b](file:///repo/notes.md:2) /repo",
    );
  });

  it("leaves a longer sibling path alone", () => {
    const sibling = `${worktree}b/shot.png ${worktree}.git/HEAD`;
    expect(retargetWorktreePaths(sibling, worktree, "/repo")).toBe(sibling);
  });
});
