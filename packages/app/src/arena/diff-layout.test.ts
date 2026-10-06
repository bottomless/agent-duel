import { describe, expect, it } from "vitest";
import { defaultDiffLayout, SPLIT_MIN_WIDTH, useArenaDiffLayoutStore } from "./diff-layout";

describe("defaultDiffLayout", () => {
  it("puts A beside B where two columns fit", () => {
    expect(defaultDiffLayout(SPLIT_MIN_WIDTH)).toBe("split");
    expect(defaultDiffLayout(1180)).toBe("split");
  });

  it("stacks into one column below that, and before the width is known", () => {
    expect(defaultDiffLayout(SPLIT_MIN_WIDTH - 1)).toBe("single");
    expect(defaultDiffLayout(null)).toBe("single");
  });
});

describe("useArenaDiffLayoutStore", () => {
  it("keeps one choice per chat", () => {
    const store = useArenaDiffLayoutStore.getState();
    store.setLayout("chat-1", "single");
    store.setLayout("chat-2", "split");
    expect(useArenaDiffLayoutStore.getState().layoutByChat).toEqual({
      "chat-1": "single",
      "chat-2": "split",
    });
  });
});
