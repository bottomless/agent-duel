/**
 * Where a note that hangs off the end of the output sits, in pixels down the terminal.
 *
 * It follows the row after the cursor while that row is on screen. The cursor can sit on the last
 * row, and it leaves the viewport entirely when the reader scrolls back — a note pinned past the
 * bottom edge is a note nobody reads, so it rests against the bottom instead.
 */
export function resolveBelowCursorTop(input: {
  /** Top of the row after the cursor, or null while the cursor is off screen or unmeasured. */
  anchor: number | null;
  outputHeight: number;
  noticeHeight: number;
}): number {
  const floor = Math.max(input.outputHeight - input.noticeHeight, 0);
  return Math.max(0, Math.min(input.anchor ?? input.outputHeight, floor));
}
