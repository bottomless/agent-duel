import type { Theme } from "@/styles/theme";

type DiffTheme = Pick<Theme, "fontSize" | "lineHeight">;

// Shared geometry keeps gutters, paired columns and stacked regions aligned at any font size.
export function diffTextHeight(theme: DiffTheme): number {
  return Math.max(theme.lineHeight.diff, Math.ceil(theme.fontSize.xs * 1.4));
}

export function diffRowHeight(theme: DiffTheme): number {
  return Math.max(20, diffTextHeight(theme) + 4);
}

// The space above and below a line in a row, for rows that grow with wrapped text and so cannot
// centre it: the first line sits where a one-line row would put it.
export function diffRowInset(theme: DiffTheme): number {
  return (diffRowHeight(theme) - diffTextHeight(theme)) / 2;
}

// Default geometry is also the content-size threshold for choosing a conflict layout.
export const ROW_HEIGHT = 20;

// Guards against rendering an unbounded number of rows for a file where nearly
// every line differs.
export const MAX_RENDERED_ROWS = 400;

// Both comparison and full-width inspection scroll inside the battle card.
export const CARD_DIFF_MAX_HEIGHT = 560;
