/** @vitest-environment jsdom */
import React, { useEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { DatabaseUpgradeChat } from "./database-upgrade-chat";

vi.mock("react-native-unistyles", async () => import("../../test-stubs/react-native-unistyles"));
vi.stubGlobal("React", React);

const message = "Upgrading your database. This chat opens when the upgrade finishes.";
const loadChat = vi.fn(async () => "Saved history and composer");
function Chat() {
  const [text, setText] = useState("Loading chat");
  useEffect(() => {
    void loadChat().then(setText);
  }, []);
  return <div>{text}</div>;
}
function upgrade(running: boolean, serverId = "test-server") {
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [serverId]: {
        ...state.sessions[serverId],
        serverInfo: {
          serverId,
          hostname: "test",
          version: "2",
          ...state.sessions[serverId].serverInfo,
          arenaDatabaseUpgrade: running ? { startedAt: 0, deadline: 600_000 } : null,
        },
      },
    },
  }));
}
beforeEach(() => {
  useSessionStore.getState().initializeSession("test-server", null as unknown as DaemonClient);
  loadChat.mockClear();
});
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession("test-server");
});
it("shows the exact message through both steps, then loads the chat automatically at ready", async () => {
  upgrade(true);
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="old">
      <Chat />
    </DatabaseUpgradeChat>,
  );
  expect(screen.getByText(message)).toBeTruthy();
  expect(loadChat).not.toHaveBeenCalled();
  // The daemon preserves the same status from import through cleanup.
  act(() => upgrade(true));
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText(/Session not found/)).toBeNull();
  act(() => upgrade(false));
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(loadChat).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(message)).toBeNull();
});
it("keeps normal starts and new chats usable", async () => {
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="old">
      <Chat />
    </DatabaseUpgradeChat>,
  );
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(screen.queryByText(message)).toBeNull();
  cleanup();
  upgrade(true);
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="">
      <textarea aria-label="New chat composer" />
    </DatabaseUpgradeChat>,
  );
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(screen.queryByText(message)).toBeNull();
});
it("does not use another host's upgrade status", async () => {
  upgrade(true);
  render(
    <DatabaseUpgradeChat serverId="other-host" agentId="old">
      <Chat />
    </DatabaseUpgradeChat>,
  );
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(screen.queryByText(message)).toBeNull();
});

it("preserves the ready-time budget fallback and suppresses its missing-session text only during upgrade", () => {
  upgrade(true);
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="old">
      <div>Failed to load agent. Session not found</div>
    </DatabaseUpgradeChat>,
  );
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText("Failed to load agent. Session not found")).toBeNull();
  act(() => upgrade(false));
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.getByText("Failed to load agent. Session not found")).toBeTruthy();
});
it("keeps a chat with loaded history visible during an upgrade", async () => {
  useSessionStore.getState().setAgentAuthoritativeHistoryApplied("test-server", "old", true);
  upgrade(true);
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="old">
      <Chat />
    </DatabaseUpgradeChat>,
  );
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(screen.queryByText(message)).toBeNull();
});
