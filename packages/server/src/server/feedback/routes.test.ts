import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  FeedbackContext,
  FeedbackSubmission,
  FeedbackSubmissionResponse,
} from "@getpaseo/protocol/feedback/schemas";
import { resolveSessionPublicKey } from "../accounts/token.js";
import { SessionResolver } from "../accounts/session.js";
import { FeedbackBackendError, type FeedbackRemote } from "./backend.js";
import { createFeedbackRouter } from "./routes.js";

const keys = generateKeyPairSync("ed25519");
const feedbackId = "9d5b3081-70b8-4d51-82d4-5d76035ea62f";

function sessionToken() {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "agent-duel-control-plane",
      aud: "agent-duel-desktop",
      sub: "user-1",
      email: "dev@example.com",
      name: "Dev",
      image: null,
      method: "email",
      iat: now,
      exp: now + 60,
    }),
  ).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

class StubFeedbackBackend implements FeedbackRemote {
  submitted: FeedbackSubmission | null = null;
  uploaded: { feedbackId: string; context: FeedbackContext } | null = null;
  contextFailure: { feedbackId: string; error: unknown; attempts: number } | null = null;
  error: FeedbackBackendError | null = null;

  async submit(_token: string, feedback: FeedbackSubmission): Promise<FeedbackSubmissionResponse> {
    if (this.error) throw this.error;
    this.submitted = feedback;
    return { id: feedback.id, emailed: true };
  }

  async uploadContext(_token: string, submittedFeedbackId: string, captured: FeedbackContext) {
    this.uploaded = { feedbackId: submittedFeedbackId, context: captured };
  }

  async reportContextFailure(
    _token: string,
    submittedFeedbackId: string,
    error: unknown,
    attempts: number,
  ) {
    this.contextFailure = { feedbackId: submittedFeedbackId, error, attempts };
  }
}

let server: Server;
let baseUrl: string;
let backend: StubFeedbackBackend;
let backgroundTask: Promise<void> | null;
let captureError: Error | null;
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
  git: {
    kind: "git",
    branch: "main",
    baseRef: "main",
    upstreamRef: "refs/remotes/origin/main",
    isDirty: true,
    aheadBehind: { ahead: 1, behind: 0 },
    diffStat: { additions: 4, deletions: 1 },
    status: "## main...origin/main [ahead 1]\n M src/app.ts",
  },
};

beforeAll(async () => {
  backend = new StubFeedbackBackend();
  const sessions = new SessionResolver(
    resolveSessionPublicKey({
      PASEO_SESSION_PUBLIC_KEY: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    }),
  );
  const app = express();
  app.use(
    "/api/feedback",
    createFeedbackRouter({
      backend,
      sessions,
      context: {
        capture: async () => {
          if (captureError) throw captureError;
          return context;
        },
      },
      startBackgroundTask: (task) => {
        backgroundTask = task();
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
);

beforeEach(() => {
  backend.submitted = null;
  backend.uploaded = null;
  backend.contextFailure = null;
  backend.error = null;
  backgroundTask = null;
  captureError = null;
});

function request(body: unknown, token = sessionToken()) {
  return fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paseo-session": token },
    body: JSON.stringify(body),
  });
}

describe("feedback route", () => {
  it("validates the signed-in request before forwarding it", async () => {
    const response = await request({
      id: feedbackId,
      source: "sidebar",
      category: "bug",
      message: "The comparison pane jumped.",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: feedbackId, emailed: true });
    expect(backend.submitted).toMatchObject({ source: "sidebar", category: "bug" });
    expect(backgroundTask).toBeNull();
  });

  it("rejects missing sessions and invalid payloads", async () => {
    const unsigned = await request(
      { id: feedbackId, source: "sidebar", category: "bug", message: "Broken" },
      "not-a-token",
    );
    expect(unsigned.status).toBe(401);
    expect(backend.submitted).toBeNull();

    const invalid = await request({ id: feedbackId, source: "chat", rating: "great" });
    expect(invalid.status).toBe(400);
    expect(backend.submitted).toBeNull();
  });

  it("stores in-chat feedback before uploading its session in the background", async () => {
    const response = await request({
      id: feedbackId,
      source: "chat",
      rating: "great",
      battleId: "battle-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });

    expect(response.status).toBe(200);
    expect(backend.submitted).toMatchObject({ source: "chat" });
    expect(backend.submitted).not.toHaveProperty("context");
    await backgroundTask;
    expect(backend.uploaded).toEqual({ feedbackId, context });
  });

  it("captures the selected chat for contextual sidebar feedback", async () => {
    const response = await request({
      id: feedbackId,
      source: "sidebar",
      category: "bug",
      message: "The current chat is stuck.",
      contextTarget: { agentId: "agent-1", workspaceId: "workspace-1" },
    });

    expect(response.status).toBe(200);
    expect(backend.submitted).toMatchObject({
      source: "sidebar",
      contextTarget: { agentId: "agent-1", workspaceId: "workspace-1" },
    });
    await backgroundTask;
    expect(backend.uploaded).toEqual({ feedbackId, context });
  });

  it("keeps submitted feedback when background context capture fails", async () => {
    captureError = new Error("Agent disappeared");
    const response = await request({
      id: feedbackId,
      source: "chat",
      rating: "great",
      battleId: "battle-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });

    expect(response.status).toBe(200);
    await backgroundTask;
    expect(backend.uploaded).toBeNull();
    expect(backend.contextFailure).toEqual({
      feedbackId,
      error: captureError,
      attempts: 0,
    });
  });

  it("turns control-plane failures into a retryable response", async () => {
    backend.error = new FeedbackBackendError(502, "Feedback email delivery failed");
    const response = await request({
      id: feedbackId,
      source: "sidebar",
      category: "general",
      message: "Hello",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Feedback email delivery failed" });
  });
});
