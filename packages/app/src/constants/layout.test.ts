import { describe, expect, it } from "vitest";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  resolveHeaderMetrics,
} from "@/constants/layout";

describe("resolveHeaderMetrics", () => {
  it("keeps the desktop header in a compact Electron window, where the window controls sit", () => {
    expect(resolveHeaderMetrics({ isCompact: true, isElectron: true })).toEqual({
      innerHeight: HEADER_INNER_HEIGHT,
      topPadding: 0,
    });
  });

  it("grows the header for touch in a compact browser window", () => {
    expect(resolveHeaderMetrics({ isCompact: true, isElectron: false })).toEqual({
      innerHeight: HEADER_INNER_HEIGHT_MOBILE,
      topPadding: HEADER_TOP_PADDING_MOBILE,
    });
  });

  it("uses the desktop header at desktop widths", () => {
    expect(resolveHeaderMetrics({ isCompact: false, isElectron: false })).toEqual({
      innerHeight: HEADER_INNER_HEIGHT,
      topPadding: 0,
    });
  });
});
