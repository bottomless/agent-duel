import type {
  ArenaComparisonDiff,
  ArenaDivergenceStatus,
} from "@getpaseo/protocol/arena/rpc-schemas";

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
  // git's verdict on the pair.
  status: ArenaDivergenceStatus;
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
 * lists them, which is every such file. The rows are the card's index into the side panel diff: enough
 * to see who changed what and how much, without rendering a hunk.
 *
 * Identical result trees can still contain changes from the frozen base.
 */
export function arenaChangesRows(diff: ArenaComparisonDiff | undefined): ArenaChangesRow[] {
  if (!diff) return [];
  return diff.files.map((file) => ({
    file: file.file,
    binary: file.binary,
    additionsA: file.additionsA,
    deletionsA: file.deletionsA,
    additionsB: file.additionsB,
    deletionsB: file.deletionsB,
    changedBy: changedBy(
      touched(file.additionsA, file.deletionsA),
      touched(file.additionsB, file.deletionsB),
    ),
    status: file.status,
  }));
}

export function arenaChangesCountLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}
