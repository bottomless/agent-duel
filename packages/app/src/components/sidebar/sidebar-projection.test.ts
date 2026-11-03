import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status" | "none";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const pinnedWorkspaceOrder: string[] = [];
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder,
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    sortMode: "default" as const,
    groupSortMode: "default" as const,
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status" | "none") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  it("preserves manual pin order until activity sorting is selected", () => {
    const input = projectionInput();
    const second = makeWorkspace("second-pin");
    input.projects[0]!.workspaces.push(second.placement);
    input.pinnedKeys.pinnedWorkspaceKeys.push(second.placement.workspaceKey);
    input.pinnedWorkspaceOrder.push("srv:pinned", second.placement.workspaceKey);
    input.workspaceEntriesByKey.set(second.entry.workspaceKey, {
      ...second.entry,
      activityAt: "2026-10-04T00:00:00Z",
    });
    const manual = buildSidebarProjection(input);
    const activity = buildSidebarProjection({ ...input, sortMode: "lastChat" });
    expect(manual.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual([
      "pinned",
      "second-pin",
    ]);
    expect(activity.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual([
      "second-pin",
      "pinned",
    ]);
    expect(activity.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "second-pin",
      "pinned",
      "unpinned",
    ]);
    expect(input.pinnedWorkspaceOrder).toEqual(["srv:pinned", "srv:second-pin"]);
  });

  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status", "none"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const entry of projection.flatWorkspaces)
        renderedProjectViewKeys.add(entry.projectViewKey);
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }
  it("shows an ungrouped list newest first, ignoring collapsed groups and excluding pins", () => {
    const input = projectionInput();
    const older = makeWorkspace("older");
    const unknown = makeWorkspace("unknown");
    const recent = input.workspaceEntriesByKey.get("srv:unpinned")!;
    input.workspaceEntriesByKey.set(recent.workspaceKey, {
      ...recent,
      activityAt: "2026-10-03T00:00:00Z",
    });
    input.workspaceEntriesByKey.set(older.entry.workspaceKey, {
      ...older.entry,
      activityAt: "2026-10-01T00:00:00Z",
    });
    input.workspaceEntriesByKey.set(unknown.entry.workspaceKey, unknown.entry);
    input.collapsedProjectKeys.add("project");
    input.collapsedWorkspaceGroupKeys.add("needs_input");

    const projection = buildSidebarProjection({ ...input, groupMode: "none" });

    expect(projection.flatWorkspaces.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
      "older",
      "unknown",
    ]);
    expect(projection.workspaceGroups).toEqual([]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "pinned",
      "unpinned",
      "older",
      "unknown",
    ]);
  });

  it("sorts status groups by latest chat and updates them when activity changes", () => {
    const input = projectionInput({ groupMode: "status" });
    const done = makeWorkspace("done", "done");
    const older = makeWorkspace("older", "done");
    input.workspaceEntriesByKey.set(done.entry.workspaceKey, {
      ...done.entry,
      activityAt: "2026-10-03T00:00:00Z",
    });
    input.workspaceEntriesByKey.set(older.entry.workspaceKey, {
      ...older.entry,
      activityAt: "2026-10-01T00:00:00Z",
    });
    const recent = input.workspaceEntriesByKey.get("srv:unpinned")!;
    input.workspaceEntriesByKey.set(recent.workspaceKey, {
      ...recent,
      activityAt: "2026-10-02T00:00:00Z",
    });

    const defaultGroupOrder = buildSidebarProjection({ ...input, sortMode: "lastChat" });
    expect(defaultGroupOrder.workspaceGroups.map((group) => group.key)).toEqual([
      "needs_input",
      "done",
    ]);

    const projection = buildSidebarProjection({
      ...input,
      sortMode: "lastChat",
      groupSortMode: "lastChat",
    });
    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["done", "needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((row) => row.workspaceId)).toEqual([
      "done",
      "older",
    ]);

    input.workspaceEntriesByKey.set(recent.workspaceKey, {
      ...recent,
      activityAt: "2026-10-04T00:00:00Z",
    });
    const updated = buildSidebarProjection({
      ...input,
      sortMode: "lastChat",
      groupSortMode: "lastChat",
    });
    expect(updated.workspaceGroups.map((group) => group.key)).toEqual(["needs_input", "done"]);
  });

  it.each([
    {
      sortMode: "lastChat" as const,
      groupSortMode: "default" as const,
      expectedGroups: ["first", "second"],
      expectedChats: ["recent", "old", "newest"],
    },
    {
      sortMode: "lastChat" as const,
      groupSortMode: "lastChat" as const,
      expectedGroups: ["second", "first"],
      expectedChats: ["newest", "recent", "old"],
    },
    {
      sortMode: "default" as const,
      groupSortMode: "lastChat" as const,
      expectedGroups: ["second", "first"],
      expectedChats: ["newest", "old", "recent"],
    },
  ])(
    "sorts chats by $sortMode independently of $groupSortMode group order",
    ({ sortMode, groupSortMode, expectedGroups, expectedChats }) => {
      const input = projectionInput();
      const old = makeWorkspace("old");
      const recent = makeWorkspace("recent");
      const newest = makeWorkspace("newest");
      input.projects = [
        { ...makeProject([old.placement, recent.placement]), viewKey: "first" },
        { ...makeProject([newest.placement]), viewKey: "second" },
      ];
      input.workspaceEntriesByKey = new Map([
        [old.entry.workspaceKey, { ...old.entry, activityAt: "2026-10-01T00:00:00Z" }],
        [recent.entry.workspaceKey, { ...recent.entry, activityAt: "2026-10-02T00:00:00Z" }],
        [newest.entry.workspaceKey, { ...newest.entry, activityAt: "2026-10-03T00:00:00Z" }],
      ]);

      const projection = buildSidebarProjection({ ...input, sortMode, groupSortMode });

      expect(projection.pinnedGroups.unpinnedProjects.map((project) => project.viewKey)).toEqual(
        expectedGroups,
      );
      expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual(
        expectedChats,
      );
      expect(input.projects.map((project) => project.viewKey)).toEqual(["first", "second"]);
      expect(input.projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
        "old",
        "recent",
      ]);
    },
  );

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});
