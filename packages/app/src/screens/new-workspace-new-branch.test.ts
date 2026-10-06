import { describe, expect, it } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import {
  localBranchAlreadyCheckedOut,
  newBranchBaseItem,
  newBranchBaseLabel,
  newBranchPickerItem,
  resolveNewBranchBase,
  validateNewBranchName,
} from "./new-workspace-new-branch";
import type { PickerItem } from "./new-workspace-picker-item";

const branchItem: PickerItem = {
  kind: "branch",
  name: "dev",
  refName: "refs/heads/dev",
  accessibilityLabel: "dev, local branch",
};

const baseItem: PickerItem = {
  kind: "branch",
  name: "main",
  refName: "refs/remotes/origin/main",
  accessibilityLabel: "main, origin branch",
};

const prItem: PickerItem = {
  kind: "github-pr",
  item: {
    kind: "change_request",
    number: 42,
    title: "Add picker",
    url: "https://example.com/pull/42",
    state: "open",
    body: null,
    labels: [],
    baseRefName: "main",
    headRefName: "feature/picker",
  } satisfies ForgeSearchItem,
};

describe("validateNewBranchName", () => {
  it("accepts a name the daemon would accept", () => {
    expect(validateNewBranchName("feature/new-picker")).toBeNull();
  });

  it("trims before judging, so surrounding spaces are not an error", () => {
    expect(validateNewBranchName("  feature/new-picker  ")).toBeNull();
  });

  it("reports an empty name separately, so the dialog can stay quiet until something is typed", () => {
    expect(validateNewBranchName("   ")).toEqual({ kind: "empty" });
  });

  it("rejects a trailing slash the daemon slug rules would let through", () => {
    expect(validateNewBranchName("feature/")).toEqual({ kind: "trailing-slash" });
  });

  it("passes the daemon's own wording through for anything else it refuses", () => {
    const error = validateNewBranchName("Feature/New");
    expect(error?.kind).toBe("slug");
    expect(error).toMatchObject({ message: expect.stringContaining("lowercase") });
  });
});

describe("newBranchBaseItem", () => {
  it("cuts from the picked branch", () => {
    expect(newBranchBaseItem(branchItem, baseItem)).toBe(branchItem);
  });

  it("falls back to the default base when a pull request is picked", () => {
    expect(newBranchBaseItem(prItem, baseItem)).toBe(baseItem);
  });

  it("falls back to the default base when nothing is picked", () => {
    expect(newBranchBaseItem(null, baseItem)).toBe(baseItem);
  });

  it("has no base when the checkout offers none", () => {
    expect(newBranchBaseItem(prItem, null)).toBeNull();
  });
});

// The picker defaults to the upstream so a detached worktree does not silently carry unpushed
// commits. Naming a branch means the opposite — start from what I have — so these two must not
// resolve to the same ref.
describe("resolveNewBranchBase", () => {
  const local = { exists: true, isRemote: false, error: null };
  const remoteOnly = { exists: true, isRemote: true, error: null };

  it("prefers the local branch over the upstream the picker defaulted to", () => {
    expect(
      resolveNewBranchBase({ baseRefName: "refs/remotes/origin/master", probe: local }),
    ).toEqual({ kind: "ref", refName: "refs/heads/master" });
  });

  it("keeps a remote-only branch, which has no local ref to prefer", () => {
    expect(
      resolveNewBranchBase({ baseRefName: "refs/remotes/origin/feature/x", probe: remoteOnly }),
    ).toEqual({ kind: "ref", refName: "refs/remotes/origin/feature/x" });
  });

  it("leaves a local ref alone", () => {
    expect(resolveNewBranchBase({ baseRefName: "refs/heads/dev", probe: local })).toEqual({
      kind: "ref",
      refName: "refs/heads/dev",
    });
  });

  it("keeps a branch named after a remote distinct from that remote's ref", () => {
    expect(resolveNewBranchBase({ baseRefName: "refs/heads/origin/main", probe: local })).toEqual({
      kind: "ref",
      refName: "refs/heads/origin/main",
    });
  });

  it("reports a base that has been deleted since the picker read it", () => {
    expect(
      resolveNewBranchBase({
        baseRefName: "refs/remotes/origin/main",
        probe: { exists: false, isRemote: false, error: null },
      }),
    ).toEqual({ kind: "missing", branchName: "main" });
  });

  it("keeps the picked ref when the probe could not answer, and lets git refuse it", () => {
    expect(resolveNewBranchBase({ baseRefName: "refs/heads/main", probe: null })).toEqual({
      kind: "ref",
      refName: "refs/heads/main",
    });
    expect(
      resolveNewBranchBase({
        baseRefName: "refs/heads/main",
        probe: { exists: false, isRemote: false, error: "not a git repository" },
      }),
    ).toEqual({ kind: "ref", refName: "refs/heads/main" });
  });
});

describe("localBranchAlreadyCheckedOut", () => {
  const named: PickerItem = {
    kind: "new-branch",
    name: "feature/auth",
    baseRefName: "refs/heads/main",
  };

  it("knows the dialog already cut and checked out the branch", () => {
    expect(localBranchAlreadyCheckedOut(named, "feature/auth")).toBe(true);
  });

  it("runs again when the checkout has moved on since", () => {
    expect(localBranchAlreadyCheckedOut(named, "main")).toBe(false);
    expect(localBranchAlreadyCheckedOut(named, null)).toBe(false);
  });

  it("never claims a plain branch row was cut by the dialog", () => {
    expect(localBranchAlreadyCheckedOut(branchItem, "dev")).toBe(false);
    expect(localBranchAlreadyCheckedOut(null, "dev")).toBe(false);
  });
});

describe("newBranchPickerItem", () => {
  it("keeps the exact base ref and trims the typed name", () => {
    expect(
      newBranchPickerItem({ name: "  feature/x  ", baseRefName: "refs/remotes/origin/main" }),
    ).toEqual({
      kind: "new-branch",
      name: "feature/x",
      baseRefName: "refs/remotes/origin/main",
    });
  });
});

describe("newBranchBaseLabel", () => {
  it("reads a remote base ref as the branch a person picked", () => {
    expect(newBranchBaseLabel("refs/remotes/origin/main")).toBe("main");
  });
});
