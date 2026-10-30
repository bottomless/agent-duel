import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarViewStorage,
  migrateSidebarViewState,
  useSidebarViewStore,
} from "./sidebar-view-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

interface MemoryStorage extends StateStorage<Promise<void>> {
  reads: string[];
}

function createMemoryStorage(entries: Record<string, string | null>): MemoryStorage {
  const reads: string[] = [];
  return {
    reads,
    getItem: async (name) => {
      reads.push(name);
      return entries[name] ?? null;
    },
    setItem: async (name, value) => {
      entries[name] = value;
    },
    removeItem: async (name) => {
      entries[name] = null;
    },
  };
}

describe("sidebar view store", () => {
  it("starts grouped by project with latest chats and saved group order", () => {
    expect(useSidebarViewStore.getInitialState()).toMatchObject({
      groupMode: "project",
      sortMode: "lastChat",
      groupSortMode: "default",
    });
  });

  it.each([null, {}, { groupMode: "invalid", sortMode: "invalid" }])(
    "uses the project and last-chat defaults for missing or invalid preferences: %j",
    (preferences) => {
      expect(migrateSidebarViewState(preferences)).toEqual({
        groupMode: "project",
        sortMode: "lastChat",
        groupSortMode: "default",
        hostFilters: [],
      });
    },
  );

  it("preserves ungrouped last-chat preferences during hydration", () => {
    expect(
      migrateSidebarViewState({ groupMode: "none", sortMode: "lastChat", hostFilters: ["host-a"] }),
    ).toEqual({
      groupMode: "none",
      sortMode: "lastChat",
      groupSortMode: "default",
      hostFilters: ["host-a"],
    });
  });

  beforeEach(() => {
    useSidebarViewStore.setState({
      groupMode: "project",
      sortMode: "lastChat",
      groupSortMode: "default",
      hostFilters: [],
    });
  });

  it("toggles multiple hosts into and out of the filter", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);

    store.toggleHostFilter("host-a");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-b"]);

    store.clearHostFilters();

    expect(useSidebarViewStore.getState().hostFilters).toEqual([]);
  });

  it("keeps host filters that still point at available hosts", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    store.reconcileHostFilters(["host-a", "host-b", "host-c"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);
  });

  it("drops a host filter after that host is removed", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("removed-host");

    store.reconcileHostFilters(["host-a"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a"]);
  });

  it("migrates legacy per-host group modes to the new global mode", () => {
    expect(
      migrateSidebarViewState({
        groupModeByServerId: {
          "host-a": "project",
          "host-b": "status",
        },
      }),
    ).toEqual({
      groupMode: "status",
      sortMode: "lastChat",
      groupSortMode: "default",
      hostFilters: [],
    });
  });

  it("migrates a pre-v2 single host filter to the multi-host list", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilter: "host-a",
      }),
    ).toEqual({
      groupMode: "status",
      sortMode: "lastChat",
      groupSortMode: "default",
      hostFilters: ["host-a"],
    });
  });

  it("keeps current persisted sidebar view state during version migration", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        sortMode: "default",
        groupSortMode: "lastChat",
        hostFilters: ["host-a", "host-b"],
      }),
    ).toEqual({
      groupMode: "status",
      sortMode: "default",
      groupSortMode: "lastChat",
      hostFilters: ["host-a", "host-b"],
    });
  });

  it("falls back to the legacy storage key when the new key is empty", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": null,
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view", "sidebar-group-mode"]);
  });

  it("uses the new storage key without reading the legacy key when current state exists", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-b": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view"]);
  });
});
