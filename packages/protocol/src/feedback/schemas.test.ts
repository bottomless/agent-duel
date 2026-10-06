import { describe, expect, it } from "vitest";
import {
  feedbackContextFailureSchema,
  feedbackContextMaximumBytes,
  feedbackContextStreamHeaderSchema,
  feedbackSubmissionSchema,
} from "./schemas.js";

const id = "9d5b3081-70b8-4d51-82d4-5d76035ea62f";

describe("feedback submission schema", () => {
  it("accepts sidebar feedback with optional app details", () => {
    expect(
      feedbackSubmissionSchema.parse({
        id,
        source: "sidebar",
        category: "idea",
        message: "Make battle results easier to compare.",
        details: {
          appVersion: "0.4.0-beta.1",
          platform: "desktop",
          operatingSystem: "MacIntel",
          locale: "en",
          screen: "/workspace/example",
        },
      }),
    ).toMatchObject({ source: "sidebar", category: "idea" });
  });

  it("accepts chat feedback without a comment", () => {
    expect(
      feedbackSubmissionSchema.parse({
        id,
        source: "chat",
        rating: "great",
        battleId: "battle-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).toMatchObject({ source: "chat", rating: "great" });
  });

  it("validates context stream headers and failure reports", () => {
    const header = {
      type: "context",
      feedbackId: id,
      attempt: 1,
      context: {
        version: 1,
        capturedAt: "2026-09-22T10:00:00.000Z",
        agent: { id: "agent-1", provider: "codex", sessionId: "session-1" },
        git: { kind: "not_git" },
      },
      transfer: {
        maxBytes: feedbackContextMaximumBytes,
        encodedBytes: 200,
        originalTimelineItems: 10,
        includedTimelineItems: 8,
        truncated: true,
      },
    };

    expect(feedbackContextStreamHeaderSchema.parse(header)).toEqual(header);
    expect(
      feedbackContextFailureSchema.parse({ feedbackId: id, attempts: 4, error: "Timed out" }),
    ).toEqual({ feedbackId: id, attempts: 4, error: "Timed out" });
    expect(() => feedbackContextStreamHeaderSchema.parse({ ...header, attempt: 5 })).toThrow();
  });

  it("rejects oversized or structurally mismatched feedback", () => {
    expect(() =>
      feedbackSubmissionSchema.parse({
        id,
        source: "sidebar",
        category: "general",
        message: "",
        rating: "great",
      }),
    ).toThrow();
    expect(() =>
      feedbackSubmissionSchema.parse({
        id,
        source: "chat",
        rating: "great",
        message: "x".repeat(2_001),
        battleId: "battle-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow();
  });
});
