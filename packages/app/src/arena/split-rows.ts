import { buildLineDiffFromLines, type DiffSegment } from "@/utils/tool-call-parsers";
import { foldRows, type CombinedDiff, type CombinedLine } from "./combined-diff";
import type { ThreeWayGapBlock } from "./three-way-diff";

/**
 * A's result beside B's, row by row, from the same rows the one-column view
 * reads. A line both have sits on one row in both columns; a line one side
 * wrote sits in that side's column facing an empty cell; a line one side
 * dropped sits struck through in that side's column while the other column
 * still has it; a line both wrote sits marked in both columns, and a line both
 * dropped sits struck in both; and where the two wrote different versions, the
 * versions are paired line by line so the words that differ can be marked. The
 * base is not drawn: the one-column view is where it is read.
 */
export type SplitCell =
  | { kind: "empty" }
  | { kind: "context"; content: string; lineNumber: number | null }
  | { kind: "changed"; content: string; lineNumber: number | null; segments?: DiffSegment[] }
  | { kind: "both"; content: string; lineNumber: number | null }
  | { kind: "removed"; content: string; lineNumber: number | null };

export interface SplitRow {
  key: string;
  a: SplitCell;
  b: SplitCell;
  /** Both columns hold the same unchanged line; folds hide runs of these. */
  shared: boolean;
}

const EMPTY: SplitCell = { kind: "empty" };

function context(content: string, lineNumber: number | null): SplitCell {
  return { kind: "context", content, lineNumber };
}

function changed(
  line: { content: string },
  lineNumber: number | null,
  segments?: DiffSegment[],
): SplitCell {
  return { kind: "changed", content: line.content, lineNumber, ...(segments ? { segments } : {}) };
}

// Two versions of a region, paired the way the stacked view marks their words:
// an identical line reads as shared, a line both rewrote gets its words marked,
// a line only one side has faces an empty cell.
function pairVersions(
  a: readonly CombinedLine[],
  b: readonly CombinedLine[],
  key: (index: number) => string,
): SplitRow[] {
  const rows: SplitRow[] = [];
  const diff = buildLineDiffFromLines(
    a.map((line) => line.content),
    b.map((line) => line.content),
  );
  let ia = 0;
  let ib = 0;
  let pendingA: Array<{ line: CombinedLine; segments?: DiffSegment[] }> = [];
  let pendingB: Array<{ line: CombinedLine; segments?: DiffSegment[] }> = [];
  const flush = () => {
    const count = Math.max(pendingA.length, pendingB.length);
    for (let index = 0; index < count; index += 1) {
      const left = pendingA[index];
      const right = pendingB[index];
      rows.push({
        key: key(rows.length),
        a: left ? changed(left.line, left.line.lineA, left.segments) : EMPTY,
        b: right ? changed(right.line, right.line.lineB, right.segments) : EMPTY,
        shared: false,
      });
    }
    pendingA = [];
    pendingB = [];
  };
  for (const entry of diff) {
    if (entry.type === "context") {
      flush();
      const left = a[ia]!;
      const right = b[ib]!;
      rows.push({
        key: key(rows.length),
        a: context(left.content, left.lineA),
        b: context(right.content, right.lineB),
        shared: true,
      });
      ia += 1;
      ib += 1;
    } else if (entry.type === "remove") {
      pendingA.push({ line: a[ia]!, ...(entry.segments ? { segments: entry.segments } : {}) });
      ia += 1;
    } else if (entry.type === "add") {
      pendingB.push({ line: b[ib]!, ...(entry.segments ? { segments: entry.segments } : {}) });
      ib += 1;
    }
  }
  flush();
  return rows;
}

export function buildSplitRows(diff: CombinedDiff): SplitRow[] {
  const rows: SplitRow[] = [];
  const key = () => `s${rows.length}`;
  // Consecutive lines the two sides wrote in the same place are two versions
  // of one region, whichever side's lines the merge listed first.
  let runA: CombinedLine[] = [];
  let runB: CombinedLine[] = [];
  const flushRun = () => {
    if (runA.length === 0 && runB.length === 0) return;
    for (const row of pairVersions(runA, runB, () => key())) rows.push(row);
    runA = [];
    runB = [];
  };
  for (const row of diff.rows) {
    if (row.kind === "added") {
      if (row.side === "a") runA.push(row.line);
      else runB.push(row.line);
      continue;
    }
    flushRun();
    if (row.kind === "shared") {
      const both = row.origin === "both";
      const cell = (lineNumber: number | null): SplitCell =>
        both
          ? { kind: "both", content: row.line.content, lineNumber }
          : context(row.line.content, lineNumber);
      rows.push({
        key: key(),
        a: cell(row.line.lineA),
        b: cell(row.line.lineB),
        shared: !both,
      });
    } else if (row.kind === "removed") {
      const dropped: SplitCell = { kind: "removed", content: row.line.content, lineNumber: null };
      if (row.side === "both") {
        rows.push({ key: key(), a: dropped, b: dropped, shared: false });
        continue;
      }
      // `side` dropped the line; the other side still has it, numbered.
      const kept = context(row.line.content, row.side === "b" ? row.line.lineA : row.line.lineB);
      rows.push({
        key: key(),
        a: row.side === "b" ? kept : dropped,
        b: row.side === "b" ? dropped : kept,
        shared: false,
      });
    } else {
      for (const paired of pairVersions(row.a, row.b, () => key())) rows.push(paired);
    }
  }
  flushRun();
  return rows;
}

export type SplitBlock = { kind: "rows"; key: string; rows: SplitRow[] } | ThreeWayGapBlock;

export function buildSplitBlocks(
  rows: readonly SplitRow[],
  revealed: ReadonlySet<number>,
  contextLines?: number,
): SplitBlock[] {
  return foldRows(
    rows.map((row) => !row.shared),
    revealed,
    contextLines,
  ).map((range) =>
    range.kind === "gap"
      ? range
      : { kind: "rows", key: range.key, rows: rows.slice(range.start, range.end) },
  );
}
