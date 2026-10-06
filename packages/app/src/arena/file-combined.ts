import type { ArenaDivergenceFile, ArenaThreeWayFile } from "@getpaseo/protocol/arena/rpc-schemas";
import { buildCombinedDiff, buildDirectDiff, type CombinedDiff } from "./combined-diff";
import { mergedContent } from "./divergence";
import { combinedMode } from "./divergence-shape";

function wholeText(side: ArenaThreeWayFile["a"]): string | null {
  return side && !side.missing && !side.truncated && !side.regions ? side.content : null;
}

// The base to tell both sides' work from context: empty when the file did
// not exist at the base, unknown (null) when the daemon sent no whole base.
export function baseTextFor(file: ArenaThreeWayFile): string | null {
  if (!file.base) return null;
  if (file.base.missing) return "";
  return wholeText(file.base);
}

/**
 * The one column for a file, or null when there is none to build: a binary, a
 * windowed file, a side git reports missing, or a merge with nothing to tell
 * apart and no base to show what both changed. Reads git's merge where its
 * conflicts stack within a screen, and A against B where the two rewrote the
 * file or the merge was too big to send.
 */
export function combinedDiffFor(
  file: ArenaThreeWayFile,
  entry: ArenaDivergenceFile | undefined,
): CombinedDiff | null {
  if (!entry || file.binary) return null;
  const merged = mergedContent(file, entry);
  if (merged !== null) {
    const built = buildCombinedDiff(merged, file.a?.content ?? "", file.b?.content ?? "", {
      base: baseTextFor(file),
    });
    const hasChanges = built.rows.some((row) => row.kind !== "shared" || row.origin === "both");
    // Text matching can miss shared moves; keep its notice even without marked rows.
    if (!hasChanges && built.baseRead !== "text") return null;
    const mode = combinedMode({ status: entry.status, largestConflict: built.largestConflict });
    if (mode === "merged") return built;
  } else if (entry.status !== "diverging") {
    return null;
  }
  const a = wholeText(file.a);
  const b = wholeText(file.b);
  if (a === null || b === null) return null;
  return buildDirectDiff(a, b, { base: baseTextFor(file) });
}
