import { describe, expect, it } from "vitest";
import { resolveBelowCursorTop } from "./terminal-below-cursor";

const pane = { outputHeight: 400, noticeHeight: 32 };

describe("resolveBelowCursorTop", () => {
  it("sits on the row after the cursor", () => {
    expect(resolveBelowCursorTop({ anchor: 72, ...pane })).toBe(72);
  });

  it("rests against the bottom when the cursor is on the last rows", () => {
    // Anchored at 390 the note would hang 22px past the pane; it stops where it still fits whole.
    expect(resolveBelowCursorTop({ anchor: 390, ...pane })).toBe(368);
  });

  it("rests against the bottom while the cursor is off screen", () => {
    expect(resolveBelowCursorTop({ anchor: null, ...pane })).toBe(368);
  });

  it("stays inside a pane too short to hold it", () => {
    expect(resolveBelowCursorTop({ anchor: 20, outputHeight: 24, noticeHeight: 32 })).toBe(0);
  });
});
