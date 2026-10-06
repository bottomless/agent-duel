import { describe, expect, it } from "vitest";
import { combinedMode, STACKED_VERSION_MAX_LINES } from "./divergence-shape";

describe("combinedMode", () => {
  it("stacks a conflict whose versions fit a screen", () => {
    expect(combinedMode({ status: "diverging", largestConflict: 1 })).toBe("merged");
    expect(combinedMode({ status: "diverging", largestConflict: STACKED_VERSION_MAX_LINES })).toBe(
      "merged",
    );
  });

  it("reads A against B once a version would not fit", () => {
    expect(
      combinedMode({ status: "diverging", largestConflict: STACKED_VERSION_MAX_LINES + 1 }),
    ).toBe("direct");
  });

  it("never leaves the merge for a file that merged cleanly", () => {
    expect(combinedMode({ status: "compatible", largestConflict: 0 })).toBe("merged");
    expect(combinedMode({ status: "only_b", largestConflict: 0 })).toBe("merged");
    expect(combinedMode({ status: undefined, largestConflict: 500 })).toBe("merged");
  });

  it("measures the screen in card rows", () => {
    expect(STACKED_VERSION_MAX_LINES).toBe(28);
  });
});
