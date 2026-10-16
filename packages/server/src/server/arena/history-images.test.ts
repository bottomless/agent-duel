import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { findHistoryImage, withHistoryImageRefs } from "./history-images.js";

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
});
