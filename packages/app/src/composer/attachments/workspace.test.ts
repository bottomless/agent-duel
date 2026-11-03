// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { composerWorkspaceAttachment } from "./workspace";
import {
  addReviewDraftComment,
  buildReviewAttachmentSnapshot,
  getReviewDraftComments,
  resetReviewDraftStore,
  useReviewDraftStore,
} from "@/review/store";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { removeSentContextAttachments } from "./workspace-cleanup";

afterEach(() => {
  cleanup();
  resetReviewDraftStore();
  resetWorkspaceAttachmentsStore();
});

function reviewAttachment() {
  return buildReviewAttachmentSnapshot({
    reviewDraftKey: "review",
    cwd: "/workspace",
    mode: "uncommitted",
    comments: getReviewDraftComments("review") ?? [],
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
  });
}

function addComment(id: string, filePath = "sample.ts") {
  return addReviewDraftComment({
    key: "review",
    comment: {
      id,
      filePath,
      side: "new",
      lineNumber: 1,
      body: id,
      createdAt: "2026-11-03T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
    },
  });
}

it("composer acknowledgement clears C1 but keeps C2 saved during the send", () => {
  const first = addComment("C1");
  const orphan = addComment("orphan", "missing.ts");
  const attachment = reviewAttachment()!;
  const { result, rerender } = renderHook(() => {
    const current = reviewAttachment();
    return composerWorkspaceAttachment.useBinding({
      normalAttachments: [],
      workspaceAttachments: current ? [current] : [],
    });
  });
  const outgoing = result.current.buildOutgoingAttachments([]);
  expect(outgoing).toEqual([attachment]);
  expect(composerWorkspaceAttachment.toSubmitAttachment(attachment)).toEqual(attachment.attachment);
  expect(attachment.attachment.comments.map((comment) => comment.body)).toEqual([first.body]);
  act(() => result.current.beginSubmit(outgoing));
  let second = first;
  act(() => {
    second = addComment("C2");
  });
  rerender();
  act(() => result.current.completeSubmit({ result: "submitted", outgoingAttachments: outgoing }));
  expect(getReviewDraftComments("review")).toEqual([orphan, second]);
  expect(result.current.selectedAttachments).toEqual([reviewAttachment()]);
});

it("composer acknowledgement keeps a sent comment edited while pending", () => {
  const first = addComment("C1");
  const { result } = renderHook(() => {
    const current = reviewAttachment();
    return composerWorkspaceAttachment.useBinding({
      normalAttachments: [],
      workspaceAttachments: current ? [current] : [],
    });
  });
  const outgoing = result.current.buildOutgoingAttachments([]);
  act(() => result.current.beginSubmit(outgoing));
  act(() =>
    useReviewDraftStore.getState().updateComment({
      key: "review",
      id: first.id,
      updates: { body: "edited" },
      updatedAt: "2026-11-03T00:01:00Z",
    }),
  );
  act(() => result.current.completeSubmit({ result: "submitted", outgoingAttachments: outgoing }));
  expect(getReviewDraftComments("review")).toEqual([
    { ...first, body: "edited", updatedAt: "2026-11-03T00:01:00Z" },
  ]);
});

it("composer acknowledgement keeps newer versions even when their text matches the send", () => {
  const first = addComment("C1");
  const { result } = renderHook(() => {
    const current = reviewAttachment();
    return composerWorkspaceAttachment.useBinding({
      normalAttachments: [],
      workspaceAttachments: current ? [current] : [],
    });
  });
  const outgoing = result.current.buildOutgoingAttachments([]);
  act(() => result.current.beginSubmit(outgoing));
  act(() => {
    useReviewDraftStore.getState().updateComment({
      key: "review",
      id: first.id,
      updates: { body: first.body },
      updatedAt: "2026-11-03T00:01:00Z",
    });
    addReviewDraftComment({ key: "review", comment: { ...first, id: "C2" } });
  });
  act(() => result.current.completeSubmit({ result: "submitted", outgoingAttachments: outgoing }));
  expect(getReviewDraftComments("review")).toEqual([
    { ...first, updatedAt: "2026-11-03T00:01:00Z" },
    { ...first, id: "C2" },
  ]);
});

it("failed composer submission keeps the review draft", () => {
  const first = addComment("C1");
  const { result } = renderHook(() => {
    const current = reviewAttachment();
    return composerWorkspaceAttachment.useBinding({
      normalAttachments: [],
      workspaceAttachments: current ? [current] : [],
    });
  });
  const outgoing = result.current.buildOutgoingAttachments([]);
  act(() => result.current.beginSubmit(outgoing));
  act(() => result.current.completeSubmit({ result: "failed", outgoingAttachments: outgoing }));
  expect(getReviewDraftComments("review")).toEqual([first]);
});

function chatHistoryAttachment(): WorkspaceComposerAttachment {
  return {
    kind: "chat_history",
    id: "chat_history:draft-1",
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: "Previous chat.",
    },
    source: {
      serverId: "local",
      agentId: "agent-1",
    },
  };
}

function pullRequestContextAttachment(): WorkspaceComposerAttachment {
  return {
    kind: "github.pull_request_comment",
    id: "comment-1",
    title: "Comment",
    text: "Please check this.",
  };
}

describe("workspace composer attachment cleanup", () => {
  it("clears sent scoped context attachments from their stores", () => {
    resetWorkspaceAttachmentsStore();
    const scopeKey = buildDraftWorkspaceAttachmentScopeKey("draft-1");
    const chatHistory = chatHistoryAttachment();
    const pullRequestContext = pullRequestContextAttachment();
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey,
      attachments: [chatHistory, pullRequestContext],
    });

    removeSentContextAttachments([chatHistory, pullRequestContext]);

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toBeUndefined();
  });
});
