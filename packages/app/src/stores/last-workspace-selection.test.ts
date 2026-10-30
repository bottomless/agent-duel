import { describe, expect, it } from "vitest";
import {
  createLastWorkspaceSelectionStore,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "./last-workspace-selection";

class DelayedWorkspaceSelectionStorage implements LastWorkspaceSelectionStorage {
  private finishRead: (value: string | null) => void = () => {};
  private readonly pendingRead = new Promise<string | null>((resolve) => {
    this.finishRead = resolve;
  });
  private saved: string | null = null;

  read(): Promise<string | null> {
    return this.pendingRead;
  }

  async write(value: string): Promise<void> {
    this.saved = value;
  }

  async remove(): Promise<void> {
    this.saved = null;
  }

  finishHydrationWith(selection: ActiveWorkspaceSelection | null) {
    this.finishRead(selection ? JSON.stringify(selection) : null);
  }

  getSavedSelection(): ActiveWorkspaceSelection | null {
    return this.saved ? (JSON.parse(this.saved) as ActiveWorkspaceSelection) : null;
  }
}

class MemoryWorkspaceSelectionStorage implements LastWorkspaceSelectionStorage {
  saved: string | null = null;

  async read(): Promise<string | null> {
    return this.saved;
  }

  async write(value: string): Promise<void> {
    this.saved = value;
  }

  async remove(): Promise<void> {
    this.saved = null;
  }
}

describe("last workspace selection", () => {
  it("hydrates the saved workspace selection", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    storage.finishHydrationWith({ serverId: "server-saved", workspaceId: "workspace-saved" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-saved",
      workspaceId: "workspace-saved",
    });
    expect(store.isHydrated()).toBe(true);
  });

  it("keeps a newer workspace selection when storage hydration finishes late", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    store.remember({ serverId: "server-new", workspaceId: "workspace-new" });
    storage.finishHydrationWith({ serverId: "server-old", workspaceId: "workspace-old" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
    expect(storage.getSavedSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
  });

  it("forgets a workspace for the next launch too", async () => {
    const storage = new MemoryWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    await store.hydrate();
    store.remember({ serverId: "server-1", workspaceId: "workspace-empty" });

    store.forget({ serverId: "server-1", workspaceId: "workspace-empty" });
    await Promise.resolve();

    expect(store.getSelection()).toBeNull();
    const relaunched = createLastWorkspaceSelectionStore(storage);
    await relaunched.hydrate();
    expect(relaunched.getSelection()).toBeNull();
  });

  it("keeps the remembered workspace when asked to forget another one", async () => {
    const storage = new MemoryWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    await store.hydrate();
    store.remember({ serverId: "server-1", workspaceId: "workspace-current" });

    store.forget({ serverId: "server-1", workspaceId: "workspace-empty" });
    await Promise.resolve();

    expect(store.getSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-current",
    });
    expect(storage.saved).toBe(
      JSON.stringify({ serverId: "server-1", workspaceId: "workspace-current" }),
    );
  });
});
