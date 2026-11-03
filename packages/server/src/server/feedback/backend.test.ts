import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  feedbackContextMaximumBytes,
  type FeedbackContext,
} from "@getpaseo/protocol/feedback/schemas";
import { FeedbackBackend, type FeedbackContextBlobUpload } from "./backend.js";

const feedbackId = "9d5b3081-70b8-4d51-82d4-5d76035ea62f";
const context: FeedbackContext = {
  version: 1,
  capturedAt: "2026-09-22T10:00:00.000Z",
  agent: { id: "agent-1", provider: "codex", sessionId: "session-1" },
  timeline: [
    {
      seq: 1,
      timestamp: "2026-09-22T09:59:00.000Z",
      item: { type: "user_message", text: "Fix the bug" },
    },
  ],
  git: { kind: "not_git" },
};

async function uploadAttempt(body: Blob) {
  const value: unknown = JSON.parse((await body.text()).split("\n")[0] ?? "null");
  if (!value || typeof value !== "object" || !("attempt" in value)) {
    throw new Error("Missing upload attempt");
  }
  return value.attempt;
}

describe("feedback backend", () => {
  it("uploads the context to Blob and confirms the uploaded pathname", async () => {
    const uploads: Array<{
      pathname: string;
      body: Blob;
      options: Parameters<FeedbackContextBlobUpload>[2];
    }> = [];
    const requests: Array<{
      url: string;
      authorization: string | null;
      version: string | null;
      body: unknown;
    }> = [];
    const backend = new FeedbackBackend("https://control-plane.test", {
      logger: pino({ level: "silent" }),
      appVersion: "0.4.0-beta.14",
      uploadBlob: async (pathname, body, options) => {
        uploads.push({ pathname, body, options });
        return { pathname: `feedback/${feedbackId}/context-1-Rand0m.jsonl` };
      },
      request: async (request) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          version: request.headers.get("x-agent-duel-version"),
          body: await request.json(),
        });
        return Response.json({ id: feedbackId, contextStatus: "complete" });
      },
    });

    await backend.uploadContext("session-token", feedbackId, context);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      pathname: `feedback/${feedbackId}/context-1.jsonl`,
      options: {
        access: "private",
        contentType: "application/x-ndjson",
        handleUploadUrl: "https://control-plane.test/api/feedback/context/upload",
        clientPayload: JSON.stringify({ feedbackId, attempt: 1 }),
        headers: { Authorization: "Bearer session-token", "X-Agent-Duel-Version": "0.4.0-beta.14" },
      },
    });
    const uploadedBytes = uploads[0]?.body.size ?? 0;
    expect(requests).toEqual([
      {
        url: "https://control-plane.test/api/feedback/context/complete",
        authorization: "Bearer session-token",
        version: "0.4.0-beta.14",
        body: {
          feedbackId,
          attempt: 1,
          pathname: `feedback/${feedbackId}/context-1-Rand0m.jsonl`,
          transfer: {
            maxBytes: feedbackContextMaximumBytes,
            encodedBytes: uploadedBytes,
            originalTimelineItems: 1,
            includedTimelineItems: 1,
            truncated: false,
          },
        },
      },
    ]);
  });

  it("retries a failed upload three times and records the final failure", async () => {
    const uploads: Blob[] = [];
    const requests: Array<{ url: string; body: unknown }> = [];
    const waits: number[] = [];
    const backend = new FeedbackBackend("https://control-plane.test", {
      logger: pino({ level: "silent" }),
      appVersion: "0.4.0-beta.14",
      uploadBlob: async (_pathname, body) => {
        uploads.push(body);
        throw new Error("Upload unavailable");
      },
      request: async (request) => {
        requests.push({ url: request.url, body: await request.json() });
        return Response.json({ id: feedbackId, contextStatus: "failed" });
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await backend.uploadContext("session-token", feedbackId, context);

    expect(await Promise.all(uploads.map(uploadAttempt))).toEqual([1, 2, 3, 4]);
    expect(waits).toEqual([250, 1_000, 2_000]);
    expect(requests).toEqual([
      {
        url: "https://control-plane.test/api/feedback/context",
        body: { feedbackId, attempts: 4, error: "Upload unavailable" },
      },
    ]);
  });
});
