import type { ArenaFileContent, ArenaThreeWayFile } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  buildWindowedThreeWayDiff,
  type ThreeWayRow,
  type ThreeWayWindowedDiff,
} from "./three-way-diff";

export type BaseRelativeDiff =
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; diff: ThreeWayWindowedDiff; truncated: boolean };

function knownEmpty(side: ArenaFileContent): boolean {
  return (
    side.missing ||
    (!side.truncated && side.content === "" && (side.regions === undefined || side.lines === 0))
  );
}

// A missing path is a known empty version; an absent payload is unknown. Do not
// feed unknown content into a diff as if the agent deleted it.
export function buildBaseRelativeDiff(file: ArenaThreeWayFile): BaseRelativeDiff {
  if (file.binary) return { kind: "unavailable", message: "Binary file changed." };
  if (!file.base) {
    return {
      kind: "unavailable",
      message: "The original was not sent, so changes from the original cannot be shown.",
    };
  }
  if (!file.a || !file.b) {
    return {
      kind: "unavailable",
      message: "An agent's file content was not sent, so this comparison is unavailable.",
    };
  }
  const sides = [file.base, file.a, file.b];
  const windows = sides.find((side) => side.regions?.length)?.regions?.length ?? 0;
  // Retention normally sends corresponding windows on all sides. If an empty
  // window was omitted on one side, its position cannot be recovered by index.
  if (
    sides.some((side) => {
      if (knownEmpty(side)) return false;
      if (windows > 0 && side.regions?.length !== windows) return true;
      if (side.truncated && !side.regions?.length) return true;
      return (
        side.regions !== undefined &&
        side.regions.reduce((sum, region) => sum + region.lines, 0) !==
          side.content.split("\n").length
      );
    })
  ) {
    return {
      kind: "unavailable",
      message:
        "The retained file regions cannot be matched reliably. Changes from the original are unavailable for this file.",
    };
  }
  const normalize = (side: ArenaFileContent) => (side.missing ? { content: "" } : side);
  return {
    kind: "ready",
    diff: buildWindowedThreeWayDiff(normalize(file.base), normalize(file.a), normalize(file.b)),
    truncated: sides.some((side) => side.truncated),
  };
}

export function bothChanged(row: ThreeWayRow, aligned: boolean): boolean {
  if (!aligned || !row.a || !row.b || row.a.type !== row.b.type) return false;
  return row.a.type !== "context" && row.a.content === row.b.content;
}
