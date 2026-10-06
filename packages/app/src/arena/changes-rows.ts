import type {
  ArenaComparisonDiff,
  ArenaDivergenceStatus,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { divergenceByFile } from "./divergence";

/** Which contestant touched a file, judged by its numstat against the base. */
export type ArenaChangedBy = "a" | "b" | "both";

export interface ArenaChangesRow {
  file: string;
  binary: boolean;
  additionsA: number;
  deletionsA: number;
  additionsB: number;
  deletionsB: number;
  changedBy: ArenaChangedBy;
  // git's verdict on the pair, when the daemon sent one.
  status?: ArenaDivergenceStatus;
}

function touched(additions: number, deletions: number): boolean {
  return additions + deletions > 0;
}

// A binary file carries no numstat, so nothing says which side changed it.
function changedBy(a: boolean, b: boolean): ArenaChangedBy {
  if (a === b) return "both";
  return a ? "a" : "b";
}

/**
 * One row per file either contestant changed, in the order the comparison
 * lists them. The rows are the card's index into the side panel diff: enough
 * to see who changed what and how much, without rendering a hunk.
 *
 * Identical result trees can still contain changes from the frozen base.
 */
export function arenaChangesRows(diff: ArenaComparisonDiff | undefined): ArenaChangesRow[] {
  if (!diff) return [];
  const divergence = divergenceByFile(diff);
  return diff.files.map((file) => {
    const a = touched(file.additionsA, file.deletionsA);
    const b = touched(file.additionsB, file.deletionsB);
    const status = divergence.get(file.file)?.status;
    return {
      file: file.file,
      binary: file.binary,
      additionsA: file.additionsA,
      deletionsA: file.deletionsA,
      additionsB: file.additionsB,
      deletionsB: file.deletionsB,
      changedBy: changedBy(a, b),
      ...(status ? { status } : {}),
    };
  });
}

export function arenaChangesCountLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}
