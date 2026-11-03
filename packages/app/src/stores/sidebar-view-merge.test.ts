import { describe, expect, it } from "vitest";
import { migrateSidebarViewState, useSidebarViewStore } from "./sidebar-view-store";

describe("merged sidebar preferences", () => {
  it("starts with last-chat sorting for both chats and groups", () => {
    expect(useSidebarViewStore.getInitialState()).toMatchObject({
      groupMode: "project",
      sortMode: "lastChat",
      groupSortMode: "lastChat",
    });
    expect(migrateSidebarViewState({})).toEqual({
      groupMode: "project",
      sortMode: "lastChat",
      groupSortMode: "lastChat",
      workspaceSort: "created",
      showBackground: false,
      hostFilters: [],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("hydrates flat activity sorting alongside the existing filters", () => {
    const preferences = {
      groupMode: "none",
      sortMode: "lastChat",
      groupSortMode: "default",
      workspaceSort: "lastPrompt",
      showBackground: true,
      hostFilters: ["host"],
      projectFilters: ["project"],
      labelFilter: { labels: ["urgent"] },
    };
    expect(migrateSidebarViewState(preferences)).toEqual(preferences);
  });

  it.each(["manual", "created", "lastPrompt"])(
    "retains an existing %s workspace order before activity sorting was added",
    (workspaceSort) => {
      expect(migrateSidebarViewState({ workspaceSort })).toMatchObject({
        workspaceSort,
        sortMode: "default",
        groupSortMode: "lastChat",
      });
    },
  );

  it("keeps an explicit default group order from main", () => {
    expect(migrateSidebarViewState({ groupSortMode: "default" }).groupSortMode).toBe("default");
  });

  it("makes a selected workspace order effective while preserving the group choice", () => {
    const initial = useSidebarViewStore.getState();
    try {
      useSidebarViewStore.setState({ sortMode: "lastChat", groupSortMode: "lastChat" });
      useSidebarViewStore.getState().setWorkspaceSort("manual");
      expect(useSidebarViewStore.getState()).toMatchObject({
        workspaceSort: "manual",
        sortMode: "default",
        groupSortMode: "lastChat",
      });
    } finally {
      useSidebarViewStore.setState(initial);
    }
  });
});
