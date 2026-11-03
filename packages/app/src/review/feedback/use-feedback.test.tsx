// @vitest-environment jsdom
import React, { useMemo } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArenaActivity } from "@getpaseo/protocol/arena/activity";
import { useArenaActivityStore } from "@/arena/activity-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  addReviewDraftComment,
  buildReviewAttachmentSnapshot,
  getReviewDraftComments,
  resetReviewDraftStore,
  useReviewDraftComments,
} from "../store";
import { useReviewFeedback } from "./use-feedback";
import { ReviewFeedbackAction } from "./surface";

const { sendAgentMessage, showToast } = vi.hoisted(() => ({
  sendAgentMessage: vi.fn<() => Promise<void>>(),
  showToast: vi.fn(),
}));

// Exercise the real workflow and stores without connecting a host or rendering tab titles.
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ sendAgentMessage }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: showToast }) }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: () => null,
  WorkspaceTabIcon: () => null,
}));

const workspaceKey = buildWorkspaceTabPersistenceKey({
  serverId: "host",
  workspaceId: "workspace",
})!;

function activity(state: ArenaActivity["state"], resolved = false): ArenaActivity {
  return {
    agentId: "chat",
    workspaceId: "workspace",
    sessionID: "session",
    chatID: "chat",
    turnID: "turn",
    title: "Chat",
    state,
    resolved,
    requiresDecision: state === "awaiting_vote",
    stale: false,
    runs: [],
  };
}

function useFeedback() {
  const comments = useReviewDraftComments("review");
  const attachment = useMemo(
    () =>
      buildReviewAttachmentSnapshot({
        reviewDraftKey: "review",
        cwd: "/workspace",
        mode: "uncommitted",
        comments,
        diffFiles: [
          {
            path: "sample.ts",
            isNew: true,
            isDeleted: false,
            additions: 1,
            deletions: 0,
            status: "ok",
            hunks: [
              {
                oldStart: 0,
                oldCount: 0,
                newStart: 1,
                newCount: 1,
                lines: [
                  { type: "header", content: "@@ -0,0 +1 @@" },
                  { type: "add", content: "hello" },
                ],
              },
            ],
          },
        ],
      }),
    [comments],
  );
  return useReviewFeedback({
    serverId: "host",
    workspaceId: "workspace",
    reviewDraftKey: "review",
    attachment,
  });
}

beforeEach(() => {
  sendAgentMessage.mockReset().mockResolvedValue();
  showToast.mockReset();
  resetReviewDraftStore();
  useArenaActivityStore.setState({ hosts: {} });
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: { kind: "agent", agentId: "chat" },
    intent: "new",
  });
  addReviewDraftComment({
    key: "review",
    comment: {
      id: "C1",
      filePath: "sample.ts",
      side: "new",
      lineNumber: 1,
      body: "Please fix this",
      createdAt: "2026-11-03T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
    },
  });
});

afterEach(() => {
  cleanup();
  resetReviewDraftStore();
  useArenaActivityStore.setState({ hosts: {} });
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
});

describe("direct Changes feedback", () => {
  it.each(["running", "awaiting_vote"] as const)(
    "hides and refuses the action during %s",
    async (state) => {
      useArenaActivityStore.getState().replace("host", [activity(state)]);
      const saved = getReviewDraftComments("review");
      const { result } = renderHook(useFeedback);
      expect(result.current.state.canSend).toBe(false);
      expect(result.current.clearance).toBe(0);
      const view = render(
        <ReviewFeedbackAction
          enabled
          hasDiff
          serverId="host"
          workspaceId="workspace"
          bottomOffset={0}
          model={result.current.model}
          state={result.current.state}
        />,
      );
      expect(view.container.textContent).toBe("");
      expect(view.queryByRole("button")).toBeNull();
      await act(() => result.current.model.press());
      await act(() => result.current.model.send("chat"));
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(getReviewDraftComments("review")).toEqual(saved);
    },
  );

  it("rechecks live battle activity before dispatch, even before the view refreshes", async () => {
    const { result } = renderHook(useFeedback);
    expect(result.current.state.canSend).toBe(true);
    const staleModel = result.current.model;
    await act(async () => {
      useArenaActivityStore.getState().replace("host", [activity("running")]);
      await staleModel.send("chat");
    });
    expect(result.current.state.disabledReason).toBe("unresolved-battle");
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(getReviewDraftComments("review")?.map((comment) => comment.id)).toEqual(["C1"]);
  });

  it("retains the draft and shows no success when the host refuses a send", async () => {
    sendAgentMessage.mockRejectedValueOnce(new Error("Host refused feedback"));
    const saved = getReviewDraftComments("review");
    const { result } = renderHook(useFeedback);
    await act(() => result.current.model.press());
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toEqual({
      kind: "failed",
      message: "Host refused feedback",
    });
    expect(getReviewDraftComments("review")).toEqual(saved);
    expect(showToast).not.toHaveBeenCalled();
    const view = render(
      <ReviewFeedbackAction
        enabled
        hasDiff
        serverId="host"
        workspaceId="workspace"
        bottomOffset={0}
        model={result.current.model}
        state={result.current.state}
      />,
    );
    expect(view.getByRole("alert").textContent).toBe("Host refused feedback");
    view.unmount();
    await act(() => result.current.model.press());
    expect(sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(getReviewDraftComments("review")).toEqual([]);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("keeps direct feedback available after a battle resolves and in another workspace", async () => {
    useArenaActivityStore.getState().replace("host", [
      activity("complete", true),
      {
        ...activity("running"),
        agentId: "another-chat",
        workspaceId: "another-workspace",
      },
    ]);
    const { result } = renderHook(useFeedback);
    expect(result.current.state.canSend).toBe(true);
    await act(() => result.current.model.press());
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(getReviewDraftComments("review")).toEqual([]);
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
