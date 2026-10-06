import { describe, expect, it } from "vitest";
import {
  feedbackContextMaximumBytes,
  type FeedbackContext,
} from "@getpaseo/protocol/feedback/schemas";
import { prepareFeedbackContextStream } from "./stream.js";

const feedbackId = "9d5b3081-70b8-4d51-82d4-5d76035ea62f";

function context(texts: readonly string[]): FeedbackContext {
  return {
    version: 1,
    capturedAt: "2026-09-22T10:00:00.000Z",
    agent: { id: "agent-1", provider: "codex", sessionId: "session-1" },
    timeline: texts.map((text, index) => ({
      seq: index + 1,
      timestamp: "2026-09-22T09:59:00.000Z",
      item: { type: "user_message", text },
    })),
    git: { kind: "not_git" },
  };
}

describe("feedback context stream", () => {
  it("encodes complete context as newline-delimited JSON", () => {
    const prepared = prepareFeedbackContextStream({
      feedbackId,
      attempt: 1,
      context: context(["first", "second"]),
    });
    const bytes = prepared.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

    expect(prepared.transfer).toEqual({
      maxBytes: feedbackContextMaximumBytes,
      encodedBytes: bytes,
      originalTimelineItems: 2,
      includedTimelineItems: 2,
      truncated: false,
    });
    expect(prepared.chunks).toHaveLength(3);
  });

  it("caps the payload at 12 MiB and retains the newest complete rows", () => {
    const prepared = prepareFeedbackContextStream({
      feedbackId,
      attempt: 1,
      context: context([
        `old-${"x".repeat(7 * 1024 * 1024)}`,
        `new-${"y".repeat(7 * 1024 * 1024)}`,
      ]),
    });
    const bytes = prepared.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const timelineLine = new TextDecoder().decode(prepared.chunks[1]);

    expect(bytes).toBeLessThanOrEqual(feedbackContextMaximumBytes);
    expect(prepared.transfer).toMatchObject({
      encodedBytes: bytes,
      originalTimelineItems: 2,
      includedTimelineItems: 1,
      truncated: true,
    });
    expect(timelineLine.startsWith('{"type":"timeline","row":{"seq":2')).toBe(true);
  });
});
