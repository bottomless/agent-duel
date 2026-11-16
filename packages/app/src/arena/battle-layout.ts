import { ARENA_PANE_BASIS_WIDTH } from "@/constants/layout";
import { SPACING } from "@/styles/theme";

/**
 * The battle's two rails: its content's inset from the panel's edges, and the gutter between the
 * two answers. The prompt, both answers, the review's columns and the decision row all sit on
 * them, so A's text, A's summary and the left edge of everything else line up.
 */
export const BATTLE_RAIL = 40;
export const BATTLE_GUTTER = 40;

/**
 * Below this width the battle stacks its two answers. It keeps them side by side until each pane
 * would fall below roughly 30–35 characters of readable content at the default interface size.
 */
export const STACKED_PANES_BREAKPOINT = 520;

/**
 * The summary widths below which the review stacks A's part above B's, set where the answers above
 * it stack. A live battle's panes measure the battle's whole width, rails included, and its review
 * sits inside the rails. A shown battle wraps its answers once their row is narrower than two pane
 * bases and their gutter, and its review sits 12px inside that row on each side.
 */
export const LIVE_SUMMARY_STACKED_BREAKPOINT = STACKED_PANES_BREAKPOINT - 2 * BATTLE_RAIL;
export const SHOWN_SUMMARY_STACKED_BREAKPOINT =
  2 * ARENA_PANE_BASIS_WIDTH + (BATTLE_GUTTER - 2 * SPACING[3]) - 2 * SPACING[3];

/** Whether the review's summary, `width` wide, stacks A's part above B's. */
export function summaryColumnsStacked(
  width: number,
  breakpoint: number = LIVE_SUMMARY_STACKED_BREAKPOINT,
): boolean {
  return width > 0 && width < breakpoint;
}
