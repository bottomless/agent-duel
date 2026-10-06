import pino from "pino";
import { describe, expect, it } from "vitest";
import type { FeedbackContext } from "@getpaseo/protocol/feedback/schemas";
import { FeedbackBackend } from "./backend.js";

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

function uploadAttempt(body: string) {
  const value: unknown = JSON.parse(body.split("\n")[0] ?? "null");
  if (!value || typeof value !== "object" || !("attempt" in value)) {
    throw new Error("Missing upload attempt");
  }
  return value.attempt;
}

describe("feedback backend", () => {
  it("retries a streamed context three times and records the final failure", async () => {
    const requests: Array<{ method: string; body: string }> = [];
    const waits: number[] = [];
    const backend = new FeedbackBackend("https://control-plane.test", {
      logger: pino({ level: "silent" }),
      request: async (request) => {
        requests.push({ method: request.method, body: await request.text() });
        if (request.method === "PUT") {
          return Response.json({ error: "Upload unavailable" }, { status: 503 });
        }
        return Response.json({ id: feedbackId, contextStatus: "failed" });
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await backend.uploadContext("session-token", feedbackId, context);

    const uploads = requests.filter((request) => request.method === "PUT");
    expect(uploads).toHaveLength(4);
    expect(uploads.map((request) => uploadAttempt(request.body))).toEqual([1, 2, 3, 4]);
    expect(waits).toEqual([250, 1_000, 2_000]);
    const failure: unknown = JSON.parse(requests[4]?.body ?? "null");
    expect(failure).toEqual({
      feedbackId,
      attempts: 4,
      error: "Upload unavailable",
    });
  });
});
