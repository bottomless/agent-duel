import { buildStatusGroups, type StatusGroup } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode, SidebarSortMode } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  statusGroups: StatusGroup[];
  flatWorkspaces: SidebarWorkspaceEntry[];
  shortcutModel: SidebarShortcutModel;
}

export function buildSidebarProjection(input: {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  groupSortMode: SidebarSortMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedStatusGroupKeys: ReadonlySet<string>;
}): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  function activityTime(workspace: SidebarWorkspacePlacement): number {
    const timestamp = input.workspaceEntriesByKey.get(workspace.workspaceKey)?.activityAt;
    return timestamp ? Date.parse(timestamp) : 0;
  }
  function compareActivity(
    left: SidebarWorkspacePlacement,
    right: SidebarWorkspacePlacement,
  ): number {
    return (
      activityTime(right) - activityTime(left) ||
      left.workspaceKey.localeCompare(right.workspaceKey)
    );
  }
  function latestActivity(workspaces: readonly SidebarWorkspacePlacement[]): number {
    return workspaces.reduce((latest, workspace) => Math.max(latest, activityTime(workspace)), 0);
  }
  if (input.sortMode === "lastChat") {
    pinnedGroups.pinnedChats = [...pinnedGroups.pinnedChats].sort(compareActivity);
    pinnedGroups.unpinnedProjects = pinnedGroups.unpinnedProjects.map((project) => ({
      ...project,
      workspaces: [...project.workspaces].sort(compareActivity),
    }));
  }
  if (input.groupSortMode === "lastChat") {
    const projectActivity = new Map(
      pinnedGroups.unpinnedProjects.map((project) => [
        project.viewKey,
        latestActivity(project.workspaces),
      ]),
    );
    pinnedGroups.unpinnedProjects = [...pinnedGroups.unpinnedProjects].sort(
      (left, right) =>
        (projectActivity.get(right.viewKey) ?? 0) - (projectActivity.get(left.viewKey) ?? 0),
    );
  }
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  const statusGroups =
    input.groupMode === "status"
      ? buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey)
      : [];
  if (input.sortMode === "lastChat") {
    for (const group of statusGroups) group.rows.sort(compareActivity);
  }
  if (input.groupSortMode === "lastChat") {
    statusGroups.sort((left, right) => latestActivity(right.rows) - latestActivity(left.rows));
  }
  // An ungrouped list is chronological even when grouped views keep their default order.
  const flatWorkspaces = input.groupMode === "none" ? unpinnedWorkspaces.sort(compareActivity) : [];

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "status") {
    sections.push(
      ...statusGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedStatusGroupKeys.has(group.bucket),
      })),
    );
  } else if (input.groupMode === "none") {
    sections.push({ workspaces: flatWorkspaces });
  } else {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  }

  return {
    pinnedGroups,
    statusGroups,
    flatWorkspaces,
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}
