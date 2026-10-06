import { describe, expect, it } from "vitest";
import { resolveSplitFloors } from "@/components/split-container-floors";
import { WORKSPACE_CHAT_MIN_WIDTH, WORKSPACE_SIDE_PANEL_MIN_WIDTH } from "@/constants/layout";

describe("resolveSplitFloors", () => {
  it("keeps the chat and the panel usable beside each other", () => {
    const floors = resolveSplitFloors({ direction: "horizontal", childIsSidePane: [false, true] });

    expect(floors.childStyles).toEqual([{ minWidth: 400 }, { minWidth: 319 }]);
    expect(floors.handle).toEqual({ leadingPx: 400, trailingPx: 319 });
  });

  it("fits the chat, the handle and the panel into the narrowest two-pane window", () => {
    // `md` is 720; below it the workspace shows one pane at a time.
    expect(WORKSPACE_CHAT_MIN_WIDTH + 1 + WORKSPACE_SIDE_PANEL_MIN_WIDTH).toBe(720);
  });

  it("lets a bottom panel take at most half the height", () => {
    const floors = resolveSplitFloors({ direction: "vertical", childIsSidePane: [false, true] });

    expect(floors.childStyles).toEqual([{ minHeight: "50%" }, { minHeight: 160 }]);
    expect(floors.handle).toEqual({ leadingShare: 0.5, trailingPx: 160 });
  });

  it("leaves any other group to the fractional minimum", () => {
    expect(
      resolveSplitFloors({ direction: "horizontal", childIsSidePane: [false, false] }).handle,
    ).toBeUndefined();
    expect(
      resolveSplitFloors({ direction: "horizontal", childIsSidePane: [true, false] }).handle,
    ).toBeUndefined();
    expect(
      resolveSplitFloors({ direction: "horizontal", childIsSidePane: [false] }).childStyles,
    ).toEqual([]);
  });
});
