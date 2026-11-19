import { describe, expect, it } from "vitest";
import {
  BATTLE_RAIL,
  SHOWN_SUMMARY_STACKED_BREAKPOINT,
  STACKED_PANES_BREAKPOINT,
  summaryColumnsStacked,
} from "./battle-layout";

describe("summaryColumnsStacked", () => {
  // The live review's summary sits inside the battle's rails, so it measures 2 × BATTLE_RAIL less
  // than the box the answers stack on.
  const summaryAt = (battleWidth: number) => battleWidth - 2 * BATTLE_RAIL;

  it("keeps the summary in two columns while the answers are side by side", () => {
    expect(summaryColumnsStacked(summaryAt(560))).toBe(false);
    expect(summaryColumnsStacked(summaryAt(STACKED_PANES_BREAKPOINT))).toBe(false);
  });

  it("stacks the summary when the answers stack", () => {
    expect(summaryColumnsStacked(summaryAt(STACKED_PANES_BREAKPOINT - 1))).toBe(true);
  });

  it("waits for a measured width", () => {
    expect(summaryColumnsStacked(0)).toBe(false);
  });
});

describe("summaryColumnsStacked in a shown battle", () => {
  // A shown battle wraps its answers once their row is narrower than two pane bases and the
  // gutter between them (656px); the review sits 12px inside that row on each side.
  const summaryAt = (threadsWidth: number) => threadsWidth - 24;

  it("stacks the summary when the shown answers wrap, and not before", () => {
    expect(summaryColumnsStacked(summaryAt(656), SHOWN_SUMMARY_STACKED_BREAKPOINT)).toBe(false);
    expect(summaryColumnsStacked(summaryAt(655), SHOWN_SUMMARY_STACKED_BREAKPOINT)).toBe(true);
  });
});
