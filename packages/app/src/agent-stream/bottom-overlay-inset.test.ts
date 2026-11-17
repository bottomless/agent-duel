import { describe, expect, it } from "vitest";
import {
  resolveBottomOverlayTailClearance,
  resolveBottomOverlayTailInset,
} from "./bottom-overlay-inset";

describe("resolveBottomOverlayTailInset", () => {
  it("adds only the space missing after existing footer clearance", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 24,
      }),
    ).toBe(32);
  });

  it("reserves the full overlay and clearance when the tail has no spacing", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 0,
      }),
    ).toBe(56);
  });
});

describe("resolveBottomOverlayTailClearance", () => {
  it("leaves the transcript gap above a floating overlay, as the track bar does", () => {
    expect(
      resolveBottomOverlayTailClearance({
        trackClearance: 62,
        overlayHeight: 120,
        transcriptClearance: 20,
      }),
    ).toBe(140);
  });

  it("clears the track bar alone when it is taller than the overlay and its gap", () => {
    expect(
      resolveBottomOverlayTailClearance({
        trackClearance: 62,
        overlayHeight: 30,
        transcriptClearance: 20,
      }),
    ).toBe(62);
  });

  it("adds no gap while no overlay is shown", () => {
    expect(
      resolveBottomOverlayTailClearance({
        trackClearance: 0,
        overlayHeight: 0,
        transcriptClearance: 20,
      }),
    ).toBe(0);
  });
});
