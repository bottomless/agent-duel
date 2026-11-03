import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test.each([false, true])(
    "preserves the exact UTF-16 prefix for oversized shell output (failed=%s)",
    (failed) => {
      const text = "x".repeat(64 * 1024 - 1) + "🙂";
      const item = limitAgentTimelineItemContent({
        type: "tool_call",
        callId: "large-shell",
        name: "Bash",
        status: failed ? "failed" : "completed",
        detail: { type: "shell", command: "echo large", output: text },
        error: failed ? { content: text } : null,
      });
      expect(item).toEqual({
        type: "tool_call",
        callId: "large-shell",
        name: "Bash",
        status: failed ? "failed" : "completed",
        detail: { type: "shell", command: "echo large", output: text.slice(0, 64 * 1024) },
        error: failed ? { content: text.slice(0, 64 * 1024) } : null,
        metadata: {
          outputTruncation: {
            originalLength: text.length,
            retainedLength: 64 * 1024,
            unit: "utf16_code_units",
          },
          ...(failed
            ? {
                errorContentTruncation: {
                  originalLength: text.length,
                  retainedLength: 64 * 1024,
                  unit: "utf16_code_units",
                },
              }
            : {}),
        },
      });
      expect(limitAgentTimelineItemContent(item)).toEqual(item);
    },
  );

  test("marks truncated plain-text tool content within the content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(limitAgentTimelineItemContent(item)).toEqual(item);
    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      metadata: {
        textTruncation: {
          originalLength: oversizedInput.length,
          retainedLength: 64 * 1024 - "\n\n[Content truncated]".length,
          unit: "utf16_code_units",
        },
      },
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024 - "\n\n[Content truncated]".length) + "\n\n[Content truncated]",
        icon: "square_terminal",
      },
    });
  });

  test.each([0, 64 * 1024])("leaves uncut tool fields unchanged at length %s", (length) => {
    const text = "x".repeat(length);
    for (const item of [
      {
        type: "tool_call" as const,
        callId: "shell",
        name: "Bash",
        status: "failed" as const,
        detail: { type: "shell" as const, command: "echo output", output: text },
        error: { content: text },
        metadata: { existing: "kept" },
      },
      {
        type: "tool_call" as const,
        callId: "text",
        name: "terminal",
        status: "completed" as const,
        detail: { type: "plain_text" as const, text },
        error: null,
      },
    ]) {
      expect(limitAgentTimelineItemContent(item)).toBe(item);
    }
  });
});
