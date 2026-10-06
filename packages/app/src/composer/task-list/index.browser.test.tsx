import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@/i18n/resources/en";
import { useSessionStore } from "@/stores/session-store";
import type { TodoListItem, UserMessageItem } from "@/types/stream";
import { AgentTaskList } from "./index";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

it("keeps the pinned list within the current turn and shows active work only while running", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const serverId = "checklist-browser";
  const agentId = "ordinary";
  useSessionStore.getState().initializeSession(serverId, null);
  const snapshot: TodoListItem = {
    kind: "todo_list",
    id: "tasks",
    provider: "opencode",
    timestamp: new Date("2026-09-11T10:01:00Z"),
    activity: { type: "created", count: 2 },
    items: [
      { text: "Inspect alpha", status: "in_progress", completed: false },
      { text: "Verify beta", status: "pending", completed: false },
    ],
  };
  useSessionStore.getState().setAgentStreamState(serverId, agentId, { tail: [snapshot] });
  useSessionStore.getState().applyAgentTurnLiveness(serverId, agentId, {
    type: "stream_open",
    turn: { turnId: "first", startedAt: snapshot.timestamp },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (battleEndedAt: string | null) => {
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <AgentTaskList serverId={serverId} agentId={agentId} battleEndedAt={battleEndedAt} />
        </I18nextProvider>,
      );
    });
  };
  await render(null);
  const counter = page.getByRole("button", { name: "0/2 tasks · Inspect alpha" });
  await expect.element(counter).toBeVisible();
  await act(async () => counter.click());
  await expect.element(page.getByLabelText("Verify beta", { exact: true })).toBeVisible();
  await act(async () => {
    useSessionStore.getState().setAgentStreamState(serverId, agentId, {
      tail: [
        {
          ...snapshot,
          items: snapshot.items.map((item) => ({
            text: item.text,
            completed: true,
            status: "completed",
          })),
        },
      ],
    });
  });
  await expect.element(page.getByRole("button", { name: "2/2 tasks" })).toBeVisible();
  await render("2026-09-11T10:02:00Z");
  expect(host.textContent).toBe("");
  await render("2026-09-11T10:00:00Z");
  await expect.element(page.getByRole("button", { name: "2/2 tasks" })).toBeVisible();
  await render(null);
  await act(async () => {
    useSessionStore.getState().applyAgentTurnLiveness(serverId, agentId, {
      type: "stream_close",
      turnId: "first",
    });
    useSessionStore.getState().setAgentStreamState(serverId, agentId, { tail: [snapshot] });
  });
  await expect.element(page.getByRole("button", { name: "0/2 tasks" })).toBeVisible();
  const nextPrompt: UserMessageItem = {
    kind: "user_message",
    id: "next-prompt",
    text: "Continue without a list",
    timestamp: new Date("2026-09-11T10:03:00Z"),
  };
  await act(async () => {
    useSessionStore.getState().setAgentStreamState(serverId, agentId, {
      tail: [snapshot, nextPrompt],
    });
  });
  expect(host.textContent).toBe("");
  await act(async () => {
    useSessionStore.getState().setAgentStreamState(serverId, agentId, {
      tail: [
        snapshot,
        nextPrompt,
        { ...snapshot, id: "new-tasks", timestamp: new Date("2026-09-11T10:04:00Z") },
      ],
    });
  });
  await expect.element(page.getByRole("button", { name: "0/2 tasks" })).toBeVisible();
});
