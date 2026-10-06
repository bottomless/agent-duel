import type {
  ArenaComparisonDiff,
  ArenaDivergenceFile,
  ArenaDivergenceStatus,
  ArenaThreeWayFile,
} from "@getpaseo/protocol/arena/rpc-schemas";

export function divergenceByFile(
  diff: ArenaComparisonDiff | undefined,
): ReadonlyMap<string, ArenaDivergenceFile> {
  const entries = diff?.divergence?.files ?? [];
  return new Map(entries.map((entry) => [entry.file, entry]));
}

/**
 * The merged text the combined view reads: git's merge for files both sides
 * touched, otherwise the one side that did the work. Null when there is no
 * whole file to read -- binary, windowed, a merge the daemon could not send,
 * or a side git reports missing.
 */
export function mergedContent(
  file: ArenaThreeWayFile,
  entry: ArenaDivergenceFile | undefined,
): string | null {
  if (!entry || file.binary) return null;
  const whole = (side: ArenaThreeWayFile["a"]) =>
    side && !side.missing && !side.truncated && !side.regions ? side.content : null;
  switch (entry.status) {
    case "compatible":
    case "diverging": {
      const merged = entry.merged;
      if (!merged || merged.missing || merged.truncated) return null;
      // A merge over windowed sides never arrives, but guard the pair anyway.
      if (file.a?.regions || file.b?.regions) return null;
      return merged.content;
    }
    case "identical":
    case "only_a":
      return whole(file.a);
    case "only_b":
      return whole(file.b);
    default:
      return null;
  }
}

export function divergenceStatusLabel(status: ArenaDivergenceStatus): string {
  switch (status) {
    case "identical":
      return "same result";
    case "diverging":
      return "diverging";
    case "compatible":
      return "compatible";
    case "only_a":
      return "A only";
    case "only_b":
      return "B only";
    case "binary":
      return "binary";
  }
}
