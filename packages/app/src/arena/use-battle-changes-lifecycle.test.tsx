/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const form = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => form.compact,
}));

import { getWorkspaceMainPane, getWorkspaceSidePane } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openBattleChanges, useBattleChangesStore } from "./battle-changes-store";
import {
  useBattleChangesLifecycle,
  useCloseBattleChangesWhenDecided,
} from "./use-battle-changes-lifecycle";

const SERVER = "server-1";
const WORKSPACE = "workspace-1";
const AGENT = "agent-1";
const KEY = buildWorkspaceTabPersistenceKey({ serverId: SERVER, workspaceId: WORKSPACE }) as string;
const TAB = `arena_changes_${AGENT}`;

type Turn = NonNullable<ArenaSnapshot["turn"]>;
const turn = (id: string, state: string) => ({ id, state }) as unknown as Turn;

let container: HTMLDivElement;
let root: Root;

function Lifecycle({ battle, reviewAvailable }: { battle: Turn; reviewAvailable: boolean }) {
  useBattleChangesLifecycle({
    serverId: SERVER,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    turn: battle,
    reviewAvailable,
  });
  return null;
}

function Closer({ battle }: { battle: Turn }) {
  useCloseBattleChangesWhenDecided({
    serverId: SERVER,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    turn: battle,
  });
  return null;
}

const layout = () => useWorkspaceLayoutStore.getState().layoutByWorkspace[KEY];
const panelTabs = () => {
  const current = layout();
  return current ? (getWorkspaceSidePane(current.root)?.tabIds ?? []) : [];
};

beforeEach(() => {
  form.compact = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useBattleChangesStore.setState({ turnByChat: {}, autoOpenedTurn: {}, dismissed: {} });
  useWorkspaceLayoutStore.getState().purgeWorkspace(KEY);
  // The chat is open and focused, as it is when a battle reaches its vote.
  useWorkspaceLayoutStore.getState().openTabFocused(KEY, { kind: "agent", agentId: AGENT });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useBattleChangesLifecycle", () => {
  it("opens the panel at the decision and leaves the chat focused", () => {
    act(() => root.render(<Lifecycle battle={turn("t1", "running")} reviewAvailable={false} />));
    expect(panelTabs()).toEqual([]);

    act(() => root.render(<Lifecycle battle={turn("t1", "awaiting_vote")} reviewAvailable />));
    expect(panelTabs()).toEqual([TAB]);
    const current = layout();
    expect(current?.focusedPaneId).toBe(current ? getWorkspaceMainPane(current.root).id : null);
    expect(useBattleChangesStore.getState().turnByChat[AGENT]).toBe("t1");
  });

  it("opens once per battle, so a reader who closed it keeps it closed", () => {
    act(() => root.render(<Lifecycle battle={turn("t1", "awaiting_vote")} reviewAvailable />));
    act(() => useWorkspaceLayoutStore.getState().closeTab(KEY, TAB));
    expect(useBattleChangesStore.getState().dismissed[AGENT]).toBe(true);

    act(() => root.render(<Lifecycle battle={turn("t2", "awaiting_vote")} reviewAvailable />));
    expect(panelTabs()).toEqual([]);
  });

  it("leaves a panel the reader hid hidden", () => {
    act(() => {
      useWorkspaceLayoutStore
        .getState()
        .openTabFocused(KEY, { kind: "terminal", terminalId: "terminal-1" });
      useWorkspaceLayoutStore.getState().setSidePanelOpen(KEY, false);
    });
    act(() => root.render(<Lifecycle battle={turn("t1", "awaiting_vote")} reviewAvailable />));
    expect(panelTabs()).toEqual(["terminal_terminal-1"]);
  });

  it("waits to be asked on a compact window, where the panel would replace the chat", () => {
    form.compact = true;
    act(() => root.render(<Lifecycle battle={turn("t1", "awaiting_vote")} reviewAvailable />));
    expect(panelTabs()).toEqual([]);
  });
});

describe("useCloseBattleChangesWhenDecided", () => {
  function openForDecision() {
    act(() => root.render(<Lifecycle battle={turn("t1", "awaiting_vote")} reviewAvailable />));
    expect(panelTabs()).toEqual([TAB]);
  }

  it("closes the panel the decision opened once the battle is decided", () => {
    openForDecision();
    act(() => root.render(<Closer battle={turn("t1", "complete")} />));
    expect(panelTabs()).toEqual([]);
    // Closing it was not the reader putting it away.
    expect(useBattleChangesStore.getState().dismissed[AGENT]).toBeUndefined();
  });

  it("keeps it open when the reader opened it themselves since", () => {
    openForDecision();
    act(() =>
      openBattleChanges({ serverId: SERVER, workspaceId: WORKSPACE, agentId: AGENT, turnId: "t1" }),
    );
    act(() => root.render(<Closer battle={turn("t1", "complete")} />));
    expect(panelTabs()).toEqual([TAB]);
  });

  it("leaves a panel the reader opened alone", () => {
    act(() =>
      useWorkspaceLayoutStore
        .getState()
        .openTabFocused(KEY, { kind: "arena_changes", agentId: AGENT }),
    );
    act(() => root.render(<Closer battle={turn("t1", "complete")} />));
    expect(panelTabs()).toEqual([TAB]);
  });
});
