import { describe, expect, it } from "vitest";
import { MissingSelectedBranchError, prepareLocalCheckout } from "./new-workspace-local-checkout";
import type { PickerItem } from "./new-workspace-picker-item";

const selected: PickerItem = {
  kind: "branch",
  name: "feature",
  refName: "refs/heads/feature",
  accessibilityLabel: "feature, local branch",
};
const messages = {
  switchFailedMessage: "Switch failed",
  createFailedMessage: "Create failed",
  missingBranchMessage: "Branch no longer exists",
};

function fixture() {
  const calls: string[] = [];
  let exists = true;
  let validationError: string | null = null;
  let switchError: string | null = null;
  let deleteOnSwitch = false;
  const client: Parameters<typeof prepareLocalCheckout>[0]["client"] = {
    validateBranch: async (options) => {
      expect(options.refreshGit).toBe(true);
      calls.push(`validate:${options.branchName}`);
      return {
        exists,
        error: validationError,
        isRemote: false,
        resolvedRef: exists ? options.branchName : null,
        requestId: "validate",
      };
    },
    checkoutSwitchBranch: async (cwd, branch) => {
      calls.push(`switch:${branch}`);
      if (deleteOnSwitch) exists = false;
      return {
        cwd,
        branch,
        success: !switchError,
        error: switchError ? { code: "UNKNOWN", message: switchError } : null,
        requestId: "switch",
      };
    },
    createBranch: async ({ cwd, branch }) => {
      calls.push(`create:${branch}`);
      return { cwd, currentBranch: branch, success: true, error: null, requestId: "create" };
    },
  };
  return {
    calls,
    run: (item: PickerItem | null = selected, currentBranch: string | null = "main") =>
      prepareLocalCheckout({ client, cwd: "/repo", item, currentBranch, ...messages }),
    missing: () => {
      exists = false;
    },
    fail: (error: string, deleted = false, probeError: string | null = null) => {
      switchError = error;
      deleteOnSwitch = deleted;
      validationError = probeError;
    },
  };
}

describe("prepareLocalCheckout", () => {
  it("leaves an unselected checkout alone, including detached HEAD", async () => {
    const f = fixture();
    await expect(f.run(null, "other")).resolves.toBe("other");
    await expect(f.run(null, null)).resolves.toBeNull();
    expect(f.calls).toEqual([]);
  });
  it("switches to an existing selected or locally created branch without creating it again", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe("feature");
    expect(f.calls).toEqual(["validate:feature", "switch:feature"]);
  });
  it("does not switch a dirty checkout already on the selected branch", async () => {
    const f = fixture();
    await expect(f.run(selected, "feature")).resolves.toBe("feature");
    expect(f.calls).toEqual(["validate:feature"]);
  });
  it("switches from detached HEAD to the explicit pick", async () => {
    const f = fixture();
    await f.run(selected, null);
    expect(f.calls).toEqual(["validate:feature", "switch:feature"]);
  });
  it("rejects a deleted selection before any mutation", async () => {
    const f = fixture();
    f.missing();
    await expect(f.run()).rejects.toBeInstanceOf(MissingSelectedBranchError);
    expect(f.calls).toEqual(["validate:feature"]);
  });
  it("recognizes deletion between validation and switch", async () => {
    const f = fixture();
    f.fail("raw git failure", true);
    await expect(f.run()).rejects.toThrow(messages.missingBranchMessage);
    expect(f.calls).toEqual(["validate:feature", "switch:feature", "validate:feature"]);
  });
  it("preserves Git's dirty-file explanation when the branch still exists", async () => {
    const f = fixture();
    f.fail("Working directory has uncommitted changes: README.md");
    await expect(f.run()).rejects.toThrow("Working directory has uncommitted changes: README.md");
  });
  it("does not interpret a failed validation as a missing branch", async () => {
    const f = fixture();
    f.fail("unused", false, "Host disconnected");
    await expect(f.run()).rejects.toThrow("Host disconnected");
    expect(f.calls).toEqual(["validate:feature"]);
  });
  it("still creates a deferred Worktree branch when switching the form to Local", async () => {
    const f = fixture();
    await expect(
      f.run({ kind: "new-branch", name: "pending", baseRefName: "refs/heads/main" }),
    ).resolves.toBe("pending");
    expect(f.calls).toEqual(["create:pending"]);
  });
});
