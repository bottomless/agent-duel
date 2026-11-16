import { describe, expect, it } from "vitest";
import { revealScrollDelta } from "./reveal-position";

const viewport = { top: 100, bottom: 700 };

describe("revealScrollDelta", () => {
  it("leaves an element that is fully in view where it is", () => {
    expect(revealScrollDelta({ viewport, element: { top: 180, bottom: 620 } })).toBe(0);
  });

  it("scrolls up to an element above the viewport", () => {
    expect(revealScrollDelta({ viewport, element: { top: -900, bottom: -460 } })).toBe(-1012);
  });

  it("scrolls down to an element below the viewport", () => {
    expect(revealScrollDelta({ viewport, element: { top: 1500, bottom: 1940 } })).toBe(1388);
  });

  it("brings the top of a partly hidden element into view", () => {
    expect(revealScrollDelta({ viewport, element: { top: 60, bottom: 500 } })).toBe(-52);
    expect(revealScrollDelta({ viewport, element: { top: 400, bottom: 840 } })).toBe(288);
  });

  it("leaves an element that covers the viewport where it is", () => {
    expect(revealScrollDelta({ viewport, element: { top: 40, bottom: 900 } })).toBe(0);
  });
});
