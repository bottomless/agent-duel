import React, { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupMode: SidebarGroupMode;
  statusGroups: StatusGroup[];
  flatWorkspaces: SidebarWorkspaceEntry[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);
const EMPTY_WORKSPACE_ENTRIES = new Map<string, SidebarWorkspaceEntry>();

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const list = useSidebarWorkspacesList();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const groupSortMode = useSidebarViewStore((state) => state.groupSortMode);
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const needsActivity =
    groupMode !== "project" || sortMode === "lastChat" || groupSortMode === "lastChat";
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || needsActivity,
  );
  const projectionWorkspaceEntriesByKey = needsActivity
    ? workspaceEntriesByKey
    : EMPTY_WORKSPACE_ENTRIES;
  const pinnedKeys = usePinnedSidebarKeys(list.projects);
  const projection = useMemo(
    () =>
      buildSidebarProjection({
        projects: list.projects,
        pinnedKeys,
        workspaceEntriesByKey: projectionWorkspaceEntriesByKey,
        projectNamesByViewKey: list.projectNamesByViewKey,
        groupMode,
        sortMode,
        groupSortMode,
        pinnedCollapsed,
        collapsedProjectKeys,
        collapsedStatusGroupKeys,
      }),
    [
      collapsedProjectKeys,
      collapsedStatusGroupKeys,
      groupMode,
      sortMode,
      groupSortMode,
      list.projectNamesByViewKey,
      list.projects,
      pinnedCollapsed,
      pinnedKeys,
      projectionWorkspaceEntriesByKey,
    ],
  );
  const value = useMemo(
    () => ({
      ...list,
      workspaceEntriesByKey,
      groupMode,
      statusGroups: projection.statusGroups,
      flatWorkspaces: projection.flatWorkspaces,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      collapsedProjectKeys,
      groupMode,
      list,
      projection,
      toggleProjectCollapsed,
      workspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
