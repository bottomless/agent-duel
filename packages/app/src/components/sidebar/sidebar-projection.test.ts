import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(id: string, statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done") {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey: "project",
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
  };
  return { placement, entry };
}

function makeProject(workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: "project",
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: "/repo",
    hosts: [
      {
        serverId: "srv",
        projectId: "project",
        iconWorkingDir: "/repo",
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
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
    collapsedStatusGroupKeys: new Set<string>(),
  };
}

describe("buildSidebarProjection", () => {
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
    input.collapsedStatusGroupKeys.add("needs_input");

    const projection = buildSidebarProjection({ ...input, groupMode: "none" });

    expect(projection.flatWorkspaces.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
      "older",
      "unknown",
    ]);
    expect(projection.statusGroups).toEqual([]);
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
    expect(defaultGroupOrder.statusGroups.map((group) => group.bucket)).toEqual([
      "needs_input",
      "done",
    ]);

    const projection = buildSidebarProjection({
      ...input,
      sortMode: "lastChat",
      groupSortMode: "lastChat",
    });
    expect(projection.statusGroups.map((group) => group.bucket)).toEqual(["done", "needs_input"]);
    expect(projection.statusGroups[0]?.rows.map((row) => row.workspaceId)).toEqual([
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
    expect(updated.statusGroups.map((group) => group.bucket)).toEqual(["needs_input", "done"]);
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

    expect(projection.statusGroups.map((group) => group.bucket)).toEqual(["needs_input"]);
    expect(projection.statusGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
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
