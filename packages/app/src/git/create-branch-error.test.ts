import { describe, expect, it } from "vitest";
import { createBranchErrorMessage } from "./create-branch-error";

const t = (key: string, options?: Record<string, unknown>): string =>
  key === "workspace.git.actions.createBranch.errors.exists"
    ? `A branch named '${String(options?.branch)}' already exists`
    : key;

function gitFailure(stderr: string): Error {
  return new Error(
    `Git command failed: git switch -c master (exit code: 128, signal: none)\n${stderr}`,
  );
}

describe("createBranchErrorMessage", () => {
  it("names the branch that is already taken", () => {
    expect(
      createBranchErrorMessage(gitFailure("fatal: a branch named 'master' already exists"), t),
    ).toBe("A branch named 'master' already exists");
  });

  it("keeps git's own reason for any other failure and drops the preamble", () => {
    expect(createBranchErrorMessage(gitFailure("fatal: not a valid object name: 'nope'"), t)).toBe(
      "Not a valid object name: 'nope'",
    );
  });

  it("reports only the first stderr line", () => {
    expect(createBranchErrorMessage(gitFailure("fatal: broken\nhint: try again"), t)).toBe(
      "Broken",
    );
  });

  it("passes through a message that is not a git command failure", () => {
    expect(createBranchErrorMessage(new Error("Daemon client unavailable"), t)).toBe(
      "Daemon client unavailable",
    );
  });

  it("handles a rejection that is not an Error", () => {
    expect(createBranchErrorMessage("something broke", t)).toBe("something broke");
  });
});
