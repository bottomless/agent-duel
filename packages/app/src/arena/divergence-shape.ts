import type { ArenaDivergenceStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import { CARD_DIFF_MAX_HEIGHT, ROW_HEIGHT } from "./diff-metrics";

// One screen of the card. A stacked conflict is read one version at a time, and
// a version longer than the screen makes the reader scroll past A to reach B.
export const STACKED_VERSION_MAX_LINES = Math.floor(CARD_DIFF_MAX_HEIGHT / ROW_HEIGHT);

/**
 * What the diff reads. git's merge, with each conflict as the two versions
 * stacked, as long as every version fits a screen; past that the two sides are
 * read against each other and the base is left out.
 */
export function combinedMode(input: {
  status: ArenaDivergenceStatus | undefined;
  largestConflict: number;
}): "merged" | "direct" {
  if (input.status === "diverging" && input.largestConflict > STACKED_VERSION_MAX_LINES) {
    return "direct";
  }
  return "merged";
}
