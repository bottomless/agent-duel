import { describe, expect, it } from "vitest";

import type { GitAction, GitActions } from "./policy";
import { getGitActionMenuActions } from "./actions-menu";

function createAction(id: GitAction["id"]): GitAction {
  return {
    id,
    label: id,
    pendingLabel: `${id}-pending`,
    successLabel: `${id}-success`,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: () => undefined,
  };
}

function createActions(input: Partial<GitActions>): GitActions {
  return {
    primary: null,
    secondary: [],
    menu: [],
    ...input,
  };
}

describe("getGitActionMenuActions", () => {
  it("includes Archive when policy promotes it to primary", () => {
    const archive = createAction("archive-workspace");

    const actions = getGitActionMenuActions(
      createActions({ primary: archive, secondary: [createAction("create-branch")] }),
    );

    expect(actions.map((action) => action.id)).toEqual(["archive-workspace", "create-branch"]);
  });

  it("deduplicates actions by id across policy buckets", () => {
    const primaryPull = createAction("pull");
    const secondaryPull = createAction("pull");

    const actions = getGitActionMenuActions(
      createActions({
        primary: primaryPull,
        secondary: [secondaryPull, createAction("push")],
        menu: [createAction("push"), createAction("archive-workspace")],
      }),
    );

    expect(actions.map((action) => action.id)).toEqual(["pull", "push", "archive-workspace"]);
    expect(actions[0]).toBe(primaryPull);
  });
});
