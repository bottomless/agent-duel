export function resolveBottomOverlayTailInset({
  requiredTailClearance,
  existingTailSpacing,
}: {
  requiredTailClearance: number;
  existingTailSpacing: number;
}): number {
  return Math.max(0, requiredTailClearance - existingTailSpacing);
}

/**
 * The space the chat's end keeps below its last line. A floating overlay (the battle's decision
 * row) sits on the composer where the track bar does, so the end clears the taller of the two, not
 * both, and keeps the track bar's gap above the overlay so its last line does not touch it.
 */
export function resolveBottomOverlayTailClearance({
  trackClearance,
  overlayHeight,
  transcriptClearance,
}: {
  trackClearance: number;
  overlayHeight: number;
  transcriptClearance: number;
}): number {
  const overlayClearance = overlayHeight > 0 ? overlayHeight + transcriptClearance : 0;
  return Math.max(trackClearance, overlayClearance);
}
