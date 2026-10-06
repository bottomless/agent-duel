/**
 * A labelled rule drawn into a terminal's scrollback by the app rather than by the shell.
 *
 * Written as SGR rather than the theme's hexes: the same buffer is read under both colour
 * schemes, and the theme can change after the rule is written. The grey is a fixed 256-colour
 * index rather than bright black, whose palette entry is a near-black in the light themes and
 * so drew the rule as a hard black line. The blank rows are part of the rule — a terminal has
 * no other spacing, and flush against the last command's output the rule reads as more output.
 */
const BLANK_ROWS_EACH_SIDE = 1;
const LEAD = "── ";
const MIN_FILL = 4;
/** xterm's greyscale ramp at #8a8a8a: quiet against a light background and a dark one alike. */
const GREY = "\x1b[38;5;245m";
const RESET = "\x1b[0m";

export function buildTerminalDivider(input: { label: string; cols: number }): string {
  const label = input.label.trim();
  const text = label ? `${label} ` : "";
  const cols = Number.isFinite(input.cols) && input.cols > 0 ? Math.floor(input.cols) : 80;
  const fill = Math.max(MIN_FILL, cols - LEAD.length - text.length - 1);
  const gap = "\r\n".repeat(BLANK_ROWS_EACH_SIDE);
  // A shell that left the cursor mid-line would otherwise have the rule appended to it.
  return `\r\n${gap}${GREY}${LEAD}${RESET}${text}${GREY}${"─".repeat(fill)}${RESET}\r\n${gap}`;
}
