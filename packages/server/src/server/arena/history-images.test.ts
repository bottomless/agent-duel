import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { findHistoryImage, withHistoryImageRefs, withStreamImageRefs } from "./history-images.js";

const replayed: AgentTimelineItem = {
  type: "user_message",
  text: "Match these",
  messageId: "msg",
  images: [
    { mimeType: "image/png", data: "AAAA" },
    { mimeType: "image/jpeg", data: "BBBBBBBB" },
  ],
};

describe("history images", () => {
  it("sends a page the images' names and sizes instead of their bytes", () => {
    expect(withHistoryImageRefs("agent", replayed)).toEqual({
      type: "user_message",
      text: "Match these",
      messageId: "msg",
      imageRefs: [
        { agentId: "agent", messageId: "msg", index: 0, mimeType: "image/png", byteSize: 3 },
        { agentId: "agent", messageId: "msg", index: 1, mimeType: "image/jpeg", byteSize: 6 },
      ],
    });
  });

  it("leaves a message it cannot name for later as it is", () => {
    const local: AgentTimelineItem = { ...replayed, messageId: undefined };
    expect(withHistoryImageRefs("agent", local)).toBe(local);
  });

  it("finds a named image in the agent's timeline", () => {
    const timeline: AgentTimelineItem[] = [{ type: "assistant_message", text: "Done" }, replayed];
    expect(findHistoryImage(timeline, "msg", 1)).toEqual({
      mimeType: "image/jpeg",
      data: "BBBBBBBB",
    });
    expect(findHistoryImage(timeline, "msg", 2)).toBeNull();
    expect(findHistoryImage(timeline, "other", 0)).toBeNull();
  });

  it("names the images of a streamed user message as a page does, and leaves other events alone", () => {
    const timeline = { type: "timeline" as const, provider: "opencode" as const, item: replayed };
    const streamed = withStreamImageRefs("agent", timeline);
    expect(streamed).toMatchObject({
      type: "timeline",
      item: { imageRefs: [{ index: 0 }, { index: 1 }] },
    });
    expect(JSON.stringify(streamed)).not.toContain("BBBBBBBB");

    const plain = {
      ...timeline,
      item: { type: "user_message" as const, text: "No images", messageId: "m" },
    };
    expect(withStreamImageRefs("agent", plain)).toBe(plain);
  });
});
