import { describe, expect, it } from "vitest";
import { computeResizeHandleSizes } from "@/components/resize-handle-sizes";

describe("computeResizeHandleSizes", () => {
  it("clamps right-edge drags to the adjacent pane minimum", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.25, 0.5, 0.25],
      index: 1,
      deltaRatio: 0.5,
    });

    expect(sizes[0]).toBe(0.25);
    expect(sizes[1]).toBe(0.65);
    expect(sizes[2]).toBeCloseTo(0.1, 10);
  });

  it("clamps left-edge drags to the adjacent pane minimum", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.25, 0.5, 0.25],
      index: 1,
      deltaRatio: -0.5,
    });

    expect(sizes[0]).toBe(0.25);
    expect(sizes[1]).toBe(0.1);
    expect(sizes[2]).toBeCloseTo(0.65, 10);
  });

  it("moves adjacent pane sizes without clamping", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.25, 0.5, 0.25],
      index: 1,
      deltaRatio: 0.05,
    });

    expect(sizes[0]).toBe(0.25);
    expect(sizes[1]).toBe(0.55);
    expect(sizes[2]).toBeCloseTo(0.2, 10);
  });

  it("splits tiny adjacent pairs evenly when the configured minimum cannot fit", () => {
    expect(
      computeResizeHandleSizes({
        sizes: [0.45, 0.05, 0.05, 0.45],
        index: 1,
        deltaRatio: 0.05,
      }),
    ).toEqual([0.45, 0.05, 0.05, 0.45]);
  });

  it("leaves sizes unchanged when the adjacent pair is invalid", () => {
    expect(
      computeResizeHandleSizes({
        sizes: [0.25, 0.5, 0.25],
        index: 3,
        deltaRatio: 0.25,
      }),
    ).toEqual([0.25, 0.5, 0.25]);
    expect(
      computeResizeHandleSizes({
        sizes: [0.25, 0, 0, 0.75],
        index: 1,
        deltaRatio: 0.25,
      }),
    ).toEqual([0.25, 0, 0, 0.75]);
  });

  it("holds the leading pane at its floor", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.6, 0.4],
      index: 0,
      deltaRatio: -0.5,
      leadingMinSize: 0.3,
    });

    expect(sizes[0]).toBe(0.3);
    expect(sizes[1]).toBeCloseTo(0.7, 10);
  });

  it("drags a split stored below the floor from where the floor draws it", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.1, 0.9],
      index: 0,
      deltaRatio: 0.05,
      leadingMinSize: 0.3,
    });

    expect(sizes[0]).toBeCloseTo(0.35, 10);
    expect(sizes[1]).toBeCloseTo(0.65, 10);
  });

  it("keeps the trailing pane's minimum when the floor cannot fit", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.5, 0.5],
      index: 0,
      deltaRatio: -0.2,
      leadingMinSize: 0.95,
    });

    expect(sizes[0]).toBe(0.9);
    expect(sizes[1]).toBeCloseTo(0.1, 10);
  });

  it("holds the trailing pane at its floor", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.5, 0.5],
      index: 0,
      deltaRatio: 0.5,
      trailingMinSize: 0.25,
    });

    expect(sizes[0]).toBe(0.75);
    expect(sizes[1]).toBeCloseTo(0.25, 10);
  });

  it("keeps the leading floor when both floors cannot fit", () => {
    const sizes = computeResizeHandleSizes({
      sizes: [0.5, 0.5],
      index: 0,
      deltaRatio: -0.4,
      leadingMinSize: 0.6,
      trailingMinSize: 0.6,
    });

    expect(sizes[0]).toBe(0.6);
    expect(sizes[1]).toBeCloseTo(0.4, 10);
  });
});
