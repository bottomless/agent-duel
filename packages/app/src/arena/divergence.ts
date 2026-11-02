import { i18n } from "@/i18n/i18next";
import type {
  ArenaDivergenceFile,
  ArenaDivergenceStatus,
  ArenaThreeWayFile,
} from "@getpaseo/protocol/arena/rpc-schemas";

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
      return i18n.t("arena.sameResult");
    case "diverging":
      return i18n.t("arena.diverging");
    case "compatible":
      return i18n.t("arena.compatible");
    case "only_a":
      return i18n.t("arena.aOnly");
    case "only_b":
      return i18n.t("arena.bOnly");
    case "binary":
      return i18n.t("arena.binary");
  }
}
