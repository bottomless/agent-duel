/** @vitest-environment jsdom */
import React, { useCallback, useEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { DatabaseUpgradeChat, DatabaseImportError } from "./database-upgrade-chat";

vi.mock("react-native-unistyles", async () => import("../../test-stubs/react-native-unistyles"));
vi.stubGlobal("React", React);

const message = "Upgrading your database. This chat opens when the upgrade finishes.";
const loadChat = vi.fn(async () => "Saved history and composer");
const noRetry = () => {};
function Chat() {
  const [text, setText] = useState("Loading chat");
  useEffect(() => {
    void loadChat().then(setText);
  }, []);
  return <div>{text}</div>;
}
function upgrade(running: boolean, serverId = "test-server", backgroundImport?: true) {
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
          arenaDatabaseUpgrade: running
            ? { startedAt: 0, deadline: 600_000, backgroundImport }
            : null,
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
it.each([undefined, true] as const)(
  "keeps a chat with loaded history visible during an upgrade, background=%s",
  async (backgroundImport) => {
    useSessionStore.getState().setAgentAuthoritativeHistoryApplied("test-server", "old", true);
    upgrade(true, "test-server", backgroundImport);
    render(
      <DatabaseUpgradeChat serverId="test-server" agentId="old">
        <Chat />
      </DatabaseUpgradeChat>,
    );
    expect(await screen.findByText("Saved history and composer")).toBeTruthy();
    expect(screen.queryByText(message)).toBeNull();
  },
);

it("allows an imported chat to load for the first time during background import", async () => {
  upgrade(true, "test-server", true);
  render(
    <DatabaseUpgradeChat serverId="test-server" agentId="old">
      <Chat />
    </DatabaseUpgradeChat>,
  );
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(loadChat).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(message)).toBeNull();
});

it.each([
  { background: true as const, error: "Session not found: ses_old", expected: message },
  { background: true as const, error: "Database unavailable", expected: "Database unavailable" },
  {
    background: undefined,
    error: "Session not found: ses_old",
    expected: "Session not found: ses_old",
  },
])(
  "renders only the missing-session import error as the pane message: $error, background=$background",
  ({ background, error, expected }) => {
    upgrade(Boolean(background), "test-server", background);
    render(
      <DatabaseImportError serverId="test-server" message={error} onRetry={noRetry}>
        <div>Failed to load agent</div>
        <div>{error}</div>
      </DatabaseImportError>,
    );
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("Failed to load agent") !== null).toBe(expected !== message);
  },
);

function RecoveringChat() {
  const [text, setText] = useState<string | null>(null);
  const retry = useCallback(() => {
    void loadChat().then(setText);
  }, []);
  if (text) return <div>{text}</div>;
  return (
    <DatabaseImportError
      serverId="test-server"
      message="Session not found: ses_old"
      onRetry={retry}
    >
      <div>Failed to load agent</div>
    </DatabaseImportError>
  );
}

it("loads the history and composer automatically when background import ends", async () => {
  upgrade(true, "test-server", true);
  render(<RecoveringChat />);
  expect(screen.getByText(message)).toBeTruthy();
  expect(loadChat).not.toHaveBeenCalled();
  act(() => upgrade(false));
  expect(await screen.findByText("Saved history and composer")).toBeTruthy();
  expect(loadChat).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(message)).toBeNull();
});
