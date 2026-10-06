import {
  buildLineDiffFromLines,
  splitIntoLines,
  type DiffLine,
  type DiffSegment,
} from "@/utils/tool-call-parsers";
import { buildSparseLineDiff } from "./sparse-line-diff";

export type ThreeWayCellType = "context" | "add" | "remove";

export interface ThreeWayCell {
  type: ThreeWayCellType;
  content: string;
  segments?: DiffSegment[];
  lineNumber: number | null;
}

export interface ThreeWayBaseCell {
  lineNumber: number;
  content: string;
}

export interface ThreeWayRow {
  key: string;
  base: ThreeWayBaseCell | null;
  a: ThreeWayCell | null;
  b: ThreeWayCell | null;
}

interface Cursor {
  ia: number;
  ib: number;
  baseLineNumber: number;
  aLineNumber: number;
  bLineNumber: number;
  rowIndex: number;
  // Rows are keyed per region, so two regions of one file cannot collide on "r0".
  keyPrefix: string;
}

// A run of rows that is actually rendered.
export interface ThreeWayRowsBlock {
  kind: "rows";
  key: string;
  rows: ThreeWayRow[];
}

// A run of unchanged rows that is hidden behind an expander.
export interface ThreeWayGapBlock {
  kind: "gap";
  key: string;
  start: number;
  end: number;
  count: number;
}

// A run of lines the backend never sent, because the file was too big to ship whole and
// this part of it changed on neither side. Distinct from a gap: a gap hides rows that are
// on the client and can be revealed, this one has nothing behind it.
export interface ThreeWayOmittedBlock {
  kind: "omitted";
  key: string;
  // Base lines between the retained window before this and the one after. Zero when the
  // count is unknown, which is what a side-only window boundary gives.
  lines: number;
}

export type ThreeWayBlock = ThreeWayRowsBlock | ThreeWayGapBlock | ThreeWayOmittedBlock;

// One retained window of a file, as the daemon cut it.
export interface ThreeWayRegion {
  start: number;
  lines: number;
}

// One side's content, plus where in the file it came from. No regions means the text is
// the whole file, which is what an older daemon sends and what any file small enough to
// ship whole still sends.
export interface ThreeWaySide {
  content: string;
  regions?: readonly ThreeWayRegion[];
  // Lines in the whole file. Without it the viewer cannot tell a last window that ends at
  // the end of the file from one that stops thousands of lines short of it.
  lines?: number;
}

export const THREE_WAY_CONTEXT_LINES = 3;

// Collapsing fewer rows than this saves less vertical space than the expander band
// itself occupies, so short runs are just shown instead.
const MIN_COLLAPSED_ROWS = 6;

function toCell(line: DiffLine, lineNumber: number | null): ThreeWayCell {
  return {
    type: line.type as ThreeWayCellType,
    content: line.content.slice(1),
    ...(line.segments ? { segments: line.segments } : {}),
    lineNumber,
  };
}

// Match additions only within the same base anchor. An extra line before a
// shared insertion must not shift every subsequent line against the other agent.
function buildInsertionRows(
  linesA: DiffLine[],
  linesB: DiffLine[],
  cursor: Cursor,
  budget: number,
): ThreeWayDiff | null {
  const a: DiffLine[] = [];
  const b: DiffLine[] = [];
  while (linesA[cursor.ia]?.type === "add") a.push(linesA[cursor.ia++]!);
  while (linesB[cursor.ib]?.type === "add") b.push(linesB[cursor.ib++]!);
  if (a.length === 0 && b.length === 0) return null;

  const matched = boundedLines(
    a.map((line) => line.content.slice(1)),
    b.map((line) => line.content.slice(1)),
    budget,
  );
  const rows: ThreeWayRow[] = [];
  let ia = 0;
  let ib = 0;
  let pendingA: DiffLine[] = [];
  let pendingB: DiffLine[] = [];
  const append = (left: DiffLine | undefined, right: DiffLine | undefined) => {
    rows.push({
      key: `${cursor.keyPrefix}r${cursor.rowIndex++}`,
      base: null,
      a: left ? toCell(left, cursor.aLineNumber++) : null,
      b: right ? toCell(right, cursor.bLineNumber++) : null,
    });
  };
  const flush = () => {
    for (let index = 0; index < Math.max(pendingA.length, pendingB.length); index++) {
      append(pendingA[index], pendingB[index]);
    }
    pendingA = [];
    pendingB = [];
  };
  for (const line of matched.lines) {
    if (line.type === "context") {
      flush();
      append(a[ia++], b[ib++]);
    } else if (line.type === "remove") pendingA.push(a[ia++]!);
    else pendingB.push(b[ib++]!);
  }
  flush();
  return { rows, aligned: matched.aligned };
}

// A base-anchored row: neither stream is inserting, so whichever of curA/curB is
// present (context or remove) names the same base line the other one names.
function buildBaseAnchoredRow(
  linesA: DiffLine[],
  linesB: DiffLine[],
  cursor: Cursor,
): ThreeWayRow | null {
  const curA = linesA[cursor.ia];
  const curB = linesB[cursor.ib];
  if (!curA && !curB) return null;

  const baseContent = (curA ?? curB)?.content.slice(1) ?? "";
  const row: ThreeWayRow = {
    key: `${cursor.keyPrefix}r${cursor.rowIndex++}`,
    base: { lineNumber: cursor.baseLineNumber, content: baseContent },
    a: curA ? toCell(curA, curA.type === "context" ? cursor.aLineNumber : null) : null,
    b: curB ? toCell(curB, curB.type === "context" ? cursor.bLineNumber : null) : null,
  };
  if (curA) {
    cursor.ia += 1;
    if (curA.type === "context") cursor.aLineNumber += 1;
  }
  if (curB) {
    cursor.ib += 1;
    if (curB.type === "context") cursor.bLineNumber += 1;
  }
  cursor.baseLineNumber += 1;
  return row;
}

// Aligning two files costs one LCS cell per pair of lines, in time and in memory
// alike, so a pair of 8k-line lockfiles is 64M cells -- enough to stall the tab before
// the row limit downstream ever gets to throw the result away. Trimming the common
// head and tail keeps that cost off the parts of the file nobody edited; a lockfile
// with one dependency bumped aligns a handful of lines instead of all of them.
//
// Past the matrix cap, sparse LCS retains order and repeated-line counts while
// budgeting equal-line pairs instead. Only a region that exceeds both budgets
// reads as a wholesale replacement; `aligned` tells the caller when that happens.
export const THREE_WAY_ALIGNMENT_BUDGET = 1_500_000;

export interface ThreeWayDiff {
  rows: ThreeWayRow[];
  // False when either side hit the cap above and was rendered as a replacement.
  aligned: boolean;
}

export interface BoundedLineDiff {
  lines: DiffLine[];
  aligned: boolean;
}

function unchangedLines(lines: readonly string[]): DiffLine[] {
  return lines.map((content) => ({ type: "context" as const, content: ` ${content}` }));
}

function replacementLines(baseLines: readonly string[], otherLines: readonly string[]): DiffLine[] {
  return [
    ...baseLines.map((content) => ({ type: "remove" as const, content: `-${content}` })),
    ...otherLines.map((content) => ({ type: "add" as const, content: `+${content}` })),
  ];
}

// Both trimming and the cap preserve the one invariant the three-way walk depends on:
// every base line still appears exactly once, in order, as a context or a remove.
export function buildBoundedLineDiff(
  baseText: string,
  otherText: string,
  budget: number,
): BoundedLineDiff {
  return boundedLines(splitIntoLines(baseText), splitIntoLines(otherText), budget);
}

function boundedLines(
  baseLines: readonly string[],
  otherLines: readonly string[],
  budget: number,
): BoundedLineDiff {
  if (baseLines.length === 0 && otherLines.length === 0) return { lines: [], aligned: true };

  let head = 0;
  while (
    head < baseLines.length &&
    head < otherLines.length &&
    baseLines[head] === otherLines[head]
  ) {
    head += 1;
  }

  let tail = 0;
  const maxTail = Math.min(baseLines.length, otherLines.length) - head;
  while (
    tail < maxTail &&
    baseLines[baseLines.length - 1 - tail] === otherLines[otherLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBase = baseLines.slice(head, baseLines.length - tail);
  const midOther = otherLines.slice(head, otherLines.length - tail);
  const fitsMatrix = midBase.length * midOther.length <= budget;
  const middle = fitsMatrix
    ? buildLineDiffFromLines(midBase, midOther)
    : buildSparseLineDiff(midBase, midOther, budget);
  const aligned = middle !== null;

  return {
    lines: [
      ...unchangedLines(baseLines.slice(0, head)),
      ...(middle ?? replacementLines(midBase, midOther)),
      ...unchangedLines(baseLines.slice(baseLines.length - tail)),
    ],
    aligned,
  };
}

// Aligns two independent base-anchored diffs (base -> A, base -> B) into shared rows
// so a file can be rendered as three columns -- Agent A, base, Agent B -- with every
// row lined up against the same point in the base file. Both diffs walk the same
// base line sequence in lockstep: whenever neither stream is mid-insertion, their
// current entries necessarily describe the same base line, so no explicit line
// index needs to be threaded through -- the two streams self-synchronize.
export function buildThreeWayDiff(
  baseText: string,
  aText: string,
  bText: string,
  budget: number = THREE_WAY_ALIGNMENT_BUDGET,
  start: { base: number; a: number; b: number } = { base: 1, a: 1, b: 1 },
  keyPrefix = "",
): ThreeWayDiff {
  const diffA = buildBoundedLineDiff(baseText, aText, budget);
  const diffB = buildBoundedLineDiff(baseText, bText, budget);
  const linesA = diffA.lines;
  const linesB = diffB.lines;
  const rows: ThreeWayRow[] = [];
  let aligned = diffA.aligned && diffB.aligned;
  const cursor: Cursor = {
    ia: 0,
    ib: 0,
    baseLineNumber: start.base,
    aLineNumber: start.a,
    bLineNumber: start.b,
    rowIndex: 0,
    keyPrefix,
  };

  while (cursor.ia < linesA.length || cursor.ib < linesB.length) {
    const inserted = buildInsertionRows(linesA, linesB, cursor, budget);
    if (inserted) {
      rows.push(...inserted.rows);
      aligned = aligned && inserted.aligned;
      continue;
    }
    const row = buildBaseAnchoredRow(linesA, linesB, cursor);
    if (!row) break;
    rows.push(row);
  }

  return { rows, aligned };
}

// A file the daemon had to window arrives as one text per side plus the line ranges it was
// cut from. Each window is aligned on its own -- alignment must not span content nobody
// sent, or a line before the break would pair with one after it -- and what sits between
// two windows is reported rather than closed over silently.
export interface ThreeWayWindowedDiff {
  rows: ThreeWayRow[];
  aligned: boolean;
  // Row indices where a run of unsent lines begins, and how many base lines it holds.
  breaks: Array<{ index: number; lines: number }>;
}

function sliceRegions(side: ThreeWaySide): string[] {
  const regions = side.regions;
  if (!regions || regions.length === 0) return [side.content];
  const lines = side.content.split("\n");
  const slices: string[] = [];
  let offset = 0;
  for (const region of regions) {
    slices.push(lines.slice(offset, offset + region.lines).join("\n"));
    offset += region.lines;
  }
  return slices;
}

// A side that is missing the file, or whose windows the daemon dropped, contributes an
// empty text to every window rather than shifting the others out of step.
function sideWindow(slices: readonly string[], index: number): string {
  return slices[index] ?? "";
}

function regionStart(side: ThreeWaySide, index: number, fallback: number): number {
  return side.regions?.[index]?.start ?? fallback;
}

// Breaks are measured on one side's line numbers, and base is that side whenever it has
// windows. A file added this turn has no base to measure against, so the geometry comes
// from whichever agent's windows are present instead.
function axisSide(base: ThreeWaySide, a: ThreeWaySide, b: ThreeWaySide): ThreeWaySide | null {
  if (base.regions?.length) return base;
  if (a.regions?.length) return a;
  if (b.regions?.length) return b;
  return null;
}

export function buildWindowedThreeWayDiff(
  base: ThreeWaySide,
  a: ThreeWaySide,
  b: ThreeWaySide,
  budget: number = THREE_WAY_ALIGNMENT_BUDGET,
): ThreeWayWindowedDiff {
  const axis = axisSide(base, a, b);
  const count = axis?.regions?.length ?? 0;
  if (!axis || count === 0) {
    const diff = buildThreeWayDiff(base.content, a.content, b.content, budget);
    return { rows: diff.rows, aligned: diff.aligned, breaks: [] };
  }

  const baseSlices = sliceRegions(base);
  const aSlices = sliceRegions(a);
  const bSlices = sliceRegions(b);
  const rows: ThreeWayRow[] = [];
  const breaks: Array<{ index: number; lines: number }> = [];
  let aligned = true;
  let previousEnd = 0;

  for (let index = 0; index < count; index += 1) {
    const region = axis.regions?.[index];
    if (!region) continue;
    if (region.start > previousEnd + 1) {
      breaks.push({ index: rows.length, lines: region.start - previousEnd - 1 });
    }
    const diff = buildThreeWayDiff(
      sideWindow(baseSlices, index),
      sideWindow(aSlices, index),
      sideWindow(bSlices, index),
      budget,
      {
        base: regionStart(base, index, region.start),
        a: regionStart(a, index, region.start),
        b: regionStart(b, index, region.start),
      },
      `w${index}-`,
    );
    aligned = aligned && diff.aligned;
    rows.push(...diff.rows);
    previousEnd = region.start + region.lines - 1;
  }

  // The file carries on past the last window. Without this the viewer stops at the last
  // hunk it was sent and says nothing, which reads as the end of the file.
  if (axis.lines !== undefined && axis.lines > previousEnd) {
    breaks.push({ index: rows.length, lines: axis.lines - previousEnd });
  }
  return { rows, aligned, breaks };
}

// Which agent columns the reader is looking at. Hiding one turns the view into a
// two-way diff of the other against base, so every question below -- what counts as
// unchanged, what collapses, which rows exist at all -- has to be answered for the
// shown columns rather than for all three. Answering them for all three is what makes
// a naive column hide look broken: rows band and carry change bars because the hidden
// agent touched them, while the columns you can see are identical.
export type ThreeWayMode = "both" | "a" | "b";

export function showsSide(mode: ThreeWayMode, side: "a" | "b"): boolean {
  return mode === "both" || mode === side;
}

// A row counts as unchanged only when every shown side positively reports context
// against the same base line. Anything else -- an insertion, a removal, or a shown
// side missing entirely -- is treated as changed, so the collapser errs toward showing
// a row rather than hiding a real difference behind an expander.
export function isUnchangedRow(row: ThreeWayRow, mode: ThreeWayMode = "both"): boolean {
  if (row.base === null) return false;
  if (showsSide(mode, "a") && row.a?.type !== "context") return false;
  if (showsSide(mode, "b") && row.b?.type !== "context") return false;
  return true;
}

// A row that exists only because a hidden agent inserted a line has nothing left to
// draw. Dropping it matters: kept, it renders as a blank line in the middle of the
// diff, and the base line numbers on either side of it read as a gap that is not there.
export function visibleThreeWayRows(
  rows: readonly ThreeWayRow[],
  mode: ThreeWayMode,
): ThreeWayRow[] {
  return rows.filter((row) => {
    if (row.base !== null) return true;
    if (showsSide(mode, "a") && row.a) return true;
    if (showsSide(mode, "b") && row.b) return true;
    return false;
  });
}

// Hiding an agent drops the rows that existed only for its insertions, which renumbers
// everything after them -- including the breaks. Filtering and renumbering in one pass is
// what keeps a break attached to the rows it actually falls between.
export function visibleThreeWayView(
  diff: ThreeWayWindowedDiff,
  mode: ThreeWayMode,
): { rows: ThreeWayRow[]; breaks: Array<{ index: number; lines: number }> } {
  const breakAt = new Map(diff.breaks.map((entry) => [entry.index, entry.lines]));
  const rows: ThreeWayRow[] = [];
  const breaks: Array<{ index: number; lines: number }> = [];
  for (let index = 0; index <= diff.rows.length; index += 1) {
    const lines = breakAt.get(index);
    if (lines !== undefined) breaks.push({ index: rows.length, lines });
    const row = diff.rows[index];
    if (!row) continue;
    if (row.base !== null || (showsSide(mode, "a") && row.a) || (showsSide(mode, "b") && row.b)) {
      rows.push(row);
    }
  }
  return { rows, breaks };
}

// Where a row sits relative to the run of changed rows around it. The renderer
// draws one hairline above the first row of a run and one below the last, in all
// three columns at once, so a hunk reads as a single horizontal band rather than
// as three separately tinted cells the eye has to pair up by position alone.
export interface ThreeWayRowFrame {
  changed: boolean;
  runStart: boolean;
  runEnd: boolean;
}

export function frameChangedRuns(
  rows: readonly ThreeWayRow[],
  mode: ThreeWayMode = "both",
): ThreeWayRowFrame[] {
  return rows.map((row, index) => {
    const changed = !isUnchangedRow(row, mode);
    if (!changed) return { changed: false, runStart: false, runEnd: false };
    return {
      changed: true,
      runStart: index === 0 || isUnchangedRow(rows[index - 1], mode),
      runEnd: index === rows.length - 1 || isUnchangedRow(rows[index + 1], mode),
    };
  });
}

// Which rows are drawn: every changed row, `contextLines` either side of one, anything the
// reader expanded, and any hidden run too short for an expander to be worth its own band.
function markVisibleRows(
  rows: readonly ThreeWayRow[],
  revealed: ReadonlySet<number>,
  mode: ThreeWayMode,
  contextLines: number,
): boolean[] {
  const visible: boolean[] = Array.from({ length: rows.length }, () => false);
  for (let index = 0; index < rows.length; index += 1) {
    if (isUnchangedRow(rows[index], mode)) continue;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(rows.length - 1, index + contextLines);
    for (let near = from; near <= to; near += 1) visible[near] = true;
  }
  revealed.forEach((index) => {
    if (index >= 0 && index < rows.length) visible[index] = true;
  });

  let runStart = -1;
  for (let index = 0; index <= rows.length; index += 1) {
    const hidden = index < rows.length && !visible[index];
    if (hidden && runStart === -1) runStart = index;
    if (!hidden && runStart !== -1) {
      if (index - runStart < MIN_COLLAPSED_ROWS) {
        for (let near = runStart; near < index; near += 1) visible[near] = true;
      }
      runStart = -1;
    }
  }
  return visible;
}

// Splits the aligned rows into rendered runs and collapsed gaps, keeping
// `contextLines` of unchanged rows around every change so each hunk reads in
// context. `revealed` holds row indices the reader has explicitly expanded.
export function buildThreeWayBlocks(
  rows: readonly ThreeWayRow[],
  revealed: ReadonlySet<number>,
  mode: ThreeWayMode = "both",
  contextLines: number = THREE_WAY_CONTEXT_LINES,
  // Row indices where the daemon stopped sending content. A run of rows never spans one:
  // the lines on either side are not neighbours, and collapsing across the break would
  // present them as if they were.
  breaks: readonly { index: number; lines: number }[] = [],
): ThreeWayBlock[] {
  const visible = markVisibleRows(rows, revealed, mode, contextLines);

  const breakAt = new Map(breaks.map((entry) => [entry.index, entry.lines]));
  const blocks: ThreeWayBlock[] = [];
  let index = 0;
  const pushBreak = (at: number) => {
    const lines = breakAt.get(at);
    if (lines === undefined) return;
    blocks.push({ kind: "omitted", key: `omitted-${at}`, lines });
  };

  pushBreak(0);
  while (index < rows.length) {
    const start = index;
    if (visible[index]) {
      index += 1;
      while (index < rows.length && visible[index] && !breakAt.has(index)) index += 1;
      blocks.push({ kind: "rows", key: `rows-${start}`, rows: rows.slice(start, index) });
    } else {
      index += 1;
      while (index < rows.length && !visible[index] && !breakAt.has(index)) index += 1;
      blocks.push({ kind: "gap", key: `gap-${start}`, start, end: index, count: index - start });
    }
    pushBreak(index);
  }
  return blocks;
}

// Guards against rendering an unbounded number of rows for a file where nearly every
// line differs -- a newly added file, for instance, collapses to nothing.
export function limitThreeWayBlocks(
  blocks: readonly ThreeWayBlock[],
  maxRows: number,
): { blocks: ThreeWayBlock[]; truncated: boolean } {
  const limited: ThreeWayBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    if (block.kind !== "rows") {
      limited.push(block);
      continue;
    }
    if (used + block.rows.length <= maxRows) {
      limited.push(block);
      used += block.rows.length;
      continue;
    }
    const remaining = maxRows - used;
    if (remaining > 0) limited.push({ ...block, rows: block.rows.slice(0, remaining) });
    return { blocks: limited, truncated: true };
  }
  return { blocks: limited, truncated: false };
}
