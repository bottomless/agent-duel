import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
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
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  flatWorkspaces: SidebarWorkspaceEntry[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  groupSortMode: SidebarSortMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  t: TFunction;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
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
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);
  if (input.sortMode === "lastChat") {
    for (const group of workspaceGroups) group.rows.sort(compareActivity);
  }
  if (input.groupSortMode === "lastChat") {
    workspaceGroups.sort((left, right) => latestActivity(right.rows) - latestActivity(left.rows));
  }
  // Flat chats always follow activity, independently of grouped ordering preferences.
  const flatWorkspaces = input.groupMode === "none" ? unpinnedWorkspaces.sort(compareActivity) : [];

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else if (input.groupMode === "none") {
    sections.push({ workspaces: flatWorkspaces });
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    flatWorkspaces,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "none":
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey, input.t),
      );
  }
}
