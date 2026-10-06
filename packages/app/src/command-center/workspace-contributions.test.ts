import { describe, expect, it } from "vitest";
import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterSource,
} from "./workspace-contributions";

function gitAction(id: GitAction["id"], label: string): GitAction {
  return {
    id,
    label,
    pendingLabel: `${label} pending`,
    successLabel: `${label} complete`,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: () => undefined,
  };
}

function source(gitActions: GitActions): {
  value: WorkspaceCommandCenterSource;
  runGitActions: GitAction[];
  dispatched: KeyboardActionDefinition[];
} {
  const runGitActions: GitAction[] = [];
  const dispatched: KeyboardActionDefinition[] = [];
  return {
    value: {
      gitActions,
      labels: {
        section: "Workspace actions",
        newTerminal: "New terminal",
        newBrowser: "New browser",
      },
      icons: {},
      shortcuts: {},
      capabilities: { canOpenBrowserTabs: true },
      dispatch: (action) => dispatched.push(action),
      runGitAction: (action) => runGitActions.push(action),
    },
    runGitActions,
    dispatched,
  };
}

describe("workspace command center contributions", () => {
  it("makes only the policy-selected primary Git action default-visible and runs it", () => {
    const primary = gitAction("commit", "Commit");
    const fixture = source({
      primary,
      secondary: [gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);
    const gitContributions = contributions.filter((item) => item.id.startsWith("git:"));
    const defaultGitContributions = gitContributions.filter((item) => item.visibility === "always");

    expect(defaultGitContributions.map((item) => item.id)).toEqual(["git:commit"]);
    defaultGitContributions[0].run();
    expect(fixture.runGitActions).toEqual([primary]);
  });

  it("does not duplicate a primary action retained in the secondary policy list", () => {
    const primary = gitAction("pull", "Pull");
    const fixture = source({
      primary,
      secondary: [primary, gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.filter((item) => item.id === "git:pull")).toHaveLength(1);
  });

  it("orders New agent before Git and keeps terminal and browser search-only", () => {
    const fixture = source({
      primary: gitAction("commit", "Commit"),
      secondary: [],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map(({ id, rank, visibility }) => ({ id, rank, visibility }))).toEqual([
      { id: "git:commit", rank: 0, visibility: "always" },
      { id: "tab:new-terminal", rank: 1, visibility: "query" },
      { id: "tab:new-browser", rank: 2, visibility: "query" },
    ]);
  });

  it("omits the browser action when the capability is unavailable", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities = { canOpenBrowserTabs: false };

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual(["tab:new-terminal"]);
  });

  it("dispatches every tab and pane command to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    for (const contribution of contributions) contribution.run();

    expect(fixture.dispatched).toEqual([
      { id: "workspace.terminal.new", scope: "workspace" },
      { id: "workspace.browser.new", scope: "workspace" },
    ]);
  });

  it("keeps workspace creation commands available outside Git", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual(["tab:new-terminal", "tab:new-browser"]);
    expect(contributions.some((item) => item.id.startsWith("git:"))).toBe(false);
  });

  it("offers the overflow menu's actions when no Git action can be promoted", () => {
    const fixture = source({
      primary: null,
      secondary: [],
      menu: [gitAction("create-branch", "Create branch"), gitAction("pull", "Pull")],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual([
      "tab:new-terminal",
      "tab:new-browser",
      "git:create-branch",
      "git:pull",
    ]);
  });
});
