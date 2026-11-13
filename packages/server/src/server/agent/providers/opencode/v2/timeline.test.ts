import { collectTimelineSnapshot } from "../test-utils/v2-timeline.js";
import type { SessionMessageAssistant } from "@opencode/client";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { V2Timeline } from "./timeline.js";

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

test.each(["running", "completed"] as const)(
  "a native %s subagent opens its saved child transcript",
  async (status) => {
    const input = {
      agent: "general",
      description: "Create quick.txt",
      prompt: "Write quick.txt and report done",
      background: true,
    };
    const metadata = { sessionID: "ses_canonical_child", status };
    const output = '<subagent sessionID="ses_canonical_child" state="completed">done</subagent>';
    const events = await collectTimelineSnapshot(new V2Timeline(), [
      assistant([
        {
          type: "tool",
          id: "call-child",
          name: "subagent",
          state:
            status === "running"
              ? { status, input, metadata }
              : { status, input, metadata, content: [{ type: "text", text: output }] },
          time: { created: 2 },
        },
      ]),
    ]);
    expect(events).toMatchObject([
      {
        type: "timeline",
        item: {
          type: "tool_call",
          name: "subagent",
          status,
          detail: {
            type: "sub_agent",
            subAgentType: "general",
            description: "Create quick.txt",
            childSessionId: "ses_canonical_child",
            log: "",
            actions: [],
          },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('"model"');
    expect(JSON.stringify(events)).not.toContain('"test"');
  },
);

test("a completed edit carries the replaced and replacement text", async () => {
  // Captured from OpenCode 2.0.18, whose edit tool takes `path` instead of `filePath`.
  const edit = assistant([
    {
      type: "tool",
      id: "call-edit",
      name: "edit",
      executed: false,
      state: {
        status: "completed",
        input: { path: "a.txt", oldString: "beta", newString: "BETA" },
        content: [{ type: "text", text: "Edited a.txt (1 replacement)" }],
        metadata: {
          files: [
            {
              file: "a.txt",
              patch:
                "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
              status: "modified",
              additions: 1,
              deletions: 1,
            },
          ],
          truncated: false,
        },
      },
      time: { created: 2, ran: 2, completed: 2 },
    },
  ]);

  expect(await collectTimelineSnapshot(new V2Timeline(), [edit])).toMatchObject([
    {
      item: {
        type: "tool_call",
        name: "edit",
        status: "completed",
        detail: { type: "edit", filePath: "a.txt", oldString: "beta", newString: "BETA" },
      },
    },
  ]);
});

test("a tool's image output is shown as an image, not as base64 in the tool output", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const screenshot = assistant([
    {
      type: "tool",
      id: "call-screenshot",
      name: "paseo_browser_screenshot",
      executed: false,
      state: {
        status: "completed",
        input: {},
        content: [
          { type: "text", text: "Captured browser screenshot (1x1)." },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png" },
        ],
        metadata: {},
      },
      time: { created: 2, ran: 2, completed: 2 },
    },
  ]);
  const timeline = new V2Timeline();

  const events = await collectTimelineSnapshot(timeline, [screenshot]);

  expect(JSON.stringify(events)).not.toContain(png);
  expect(events.map((event) => event.type === "timeline" && event.item)).toMatchObject([
    {
      type: "tool_call",
      name: "paseo_browser_screenshot",
      status: "completed",
      detail: { output: "Captured browser screenshot (1x1).\n[image]" },
    },
    {
      type: "assistant_message",
      text: expect.stringMatching(/^\n\n!\[Image\]\(file:\/\/.*paseo-attachments.*\.png\)\n\n$/),
    },
  ]);
  expect(await collectTimelineSnapshot(timeline, [screenshot])).toEqual([]);
});

test("a surrogate pair split across deltas streams back intact", () => {
  const timeline = new V2Timeline();
  const part = { assistantMessageID: "answer", type: "text" as const, ordinal: 0 };
  timeline.startPart(part);
  const chunks = ["a\uD83D", "\uDE00b"].map((delta) => {
    const event = timeline.delta({ ...part, delta });
    return event?.type === "timeline" && event.item.type === "assistant_message"
      ? event.item.text
      : null;
  });
  expect(chunks).toEqual(["a\uD83D", "\uDE00b"]);
  expect(chunks.join("")).toBe("a😀b");
});

function retainedBytesAfterStreaming(mode: "delta" | "snapshot", chunks: number): number {
  const fixture = fileURLToPath(
    new URL("../test-utils/v2-streamed-text-memory.ts", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fixture, mode, String(chunks)],
    { encoding: "utf8" },
  );
  return Number(output);
}

test.each(["delta", "snapshot"] as const)(
  "a long %s-streamed part holds memory in proportion to its text",
  (mode) => {
    const chunks = 2000;
    const textBytes = chunks * 64;
    expect(retainedBytesAfterStreaming(mode, chunks)).toBeLessThan(textBytes * 32);
  },
);

test("a battle steer is dated when the user sent it, not when the runner delivered it", async () => {
  const sent = Date.UTC(2026, 9, 30, 14, 10, 1, 174);
  const delivered = Date.UTC(2026, 9, 30, 14, 10, 50, 522);
  const events = await collectTimelineSnapshot(new V2Timeline(), [
    {
      id: "steer",
      type: "user",
      text: "STEER-ONE",
      metadata: { arenaSentAt: sent },
      time: { created: delivered },
    },
    { id: "prompt", type: "user", text: "plain", time: { created: delivered } },
  ]);
  expect(events.map((event) => event.type === "timeline" && event.timestamp)).toEqual([
    new Date(sent).toISOString(),
    new Date(delivered).toISOString(),
  ]);
});
