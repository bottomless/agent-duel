import { describe, expect, it } from "vitest";
import { createContentMutationCallback } from "./content-mutation";

function createViewport() {
  const content = { scrollHeight: 5788 };
  const viewport = { scrollTop: 802.5, clientHeight: 632, following: true };
  const scrollPositions: number[] = [];
  const onMutation = createContentMutationCallback({
    content,
    shouldFollow: () => viewport.following,
    forceStickToBottom() {
      viewport.scrollTop = content.scrollHeight - viewport.clientHeight;
      scrollPositions.push(viewport.scrollTop);
    },
  });
  return { content, viewport, scrollPositions, onMutation };
}

describe("content mutations while following output", () => {
  it("does not scroll for same-height mutations such as a heading's hover icon swap", () => {
    const { viewport, scrollPositions, onMutation } = createViewport();

    onMutation();
    onMutation();

    expect(viewport.scrollTop).toBe(802.5);
    expect(scrollPositions).toEqual([]);
  });

  it("follows each paced text growth and ignores same-height mutations between reveals", () => {
    const { content, viewport, scrollPositions, onMutation } = createViewport();

    content.scrollHeight = 5808;
    onMutation();
    expect(viewport.scrollTop).toBe(5176);
    onMutation();
    content.scrollHeight = 5828;
    onMutation();
    expect(viewport.scrollTop).toBe(5196);
    onMutation();

    expect(scrollPositions).toEqual([5176, 5196]);
  });

  it("measures growth while following is paused without scrolling on a same-height mutation after resume", () => {
    const { content, viewport, scrollPositions, onMutation } = createViewport();

    viewport.following = false;
    content.scrollHeight = 5808;
    onMutation();
    expect(viewport.scrollTop).toBe(802.5);
    expect(scrollPositions).toEqual([]);

    viewport.following = true;
    onMutation();
    expect(viewport.scrollTop).toBe(802.5);
    expect(scrollPositions).toEqual([]);

    content.scrollHeight = 5828;
    onMutation();
    expect(viewport.scrollTop).toBe(5196);
    expect(scrollPositions).toEqual([5196]);
  });
});
