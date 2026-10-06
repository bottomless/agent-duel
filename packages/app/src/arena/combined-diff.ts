import {
  buildLineDiffFromLines,
  splitIntoLines,
  type DiffLine,
  type DiffSegment,
} from "@/utils/tool-call-parsers";
import {
  buildBoundedLineDiff,
  THREE_WAY_ALIGNMENT_BUDGET,
  THREE_WAY_CONTEXT_LINES,
  type ThreeWayGapBlock,
} from "./three-way-diff";

/**
 * One column for two results.
 *
 * git's merge of A and B over the base is the spine: a line both sides have is
 * shown once, a line only one side has is tinted for that side, and where the
 * two wrote the same region differently the merge left a zdiff3 conflict, which
 * becomes one row holding A's version, the base, and B's version stacked. The
 * merge is read against each side with the same line aligner the three columns
 * use, so "who added this" is git's answer, not a guess from column positions.
 * It is read against the base too, so a line both sides wrote is told from a
 * line the base had: work the two did alike is work, not context, and a line
 * both dropped still leaves a row.
 */
export interface CombinedLine {
  key: string;
  content: string;
  segments?: DiffSegment[];
  lineA: number | null;
  lineB: number | null;
}

export type CombinedRow =
  // In the merge and on both sides. `origin` says whether the base had the
  // line or both sides wrote it.
  | { key: string; kind: "shared"; origin: "base" | "both"; line: CombinedLine }
  // In the merge and in `side` only: that side wrote it.
  | { key: string; kind: "added"; side: "a" | "b"; line: CombinedLine }
  // Not in the merge; `side` dropped it while the other side still has it, or
  // `both` dropped a line the base had.
  | { key: string; kind: "removed"; side: "a" | "b" | "both"; line: CombinedLine }
  | { key: string; kind: "conflict"; a: CombinedLine[]; base: CombinedLine[]; b: CombinedLine[] };

export interface CombinedDiff {
  rows: CombinedRow[];
  // `merged` reads git's merge; `direct` reads A against B with the base left out.
  mode: "merged" | "direct";
  // False when either side hit the alignment cap and reads as a replacement.
  aligned: boolean;
  // Lines inside conflict blocks, all three parts counted.
  conflictLines: number;
  // Lines in the merged file, markers excluded.
  mergedLines: number;
  // The longest version either side put in one conflict block.
  largestConflict: number;
  // How the base was read to tell both sides' work from context: `aligned`
  // line by line; `text` past the alignment budget, where a line the base
  // never had anywhere is both sides' and a line both dropped is not placed;
  // `none` when the daemon sent no whole base, so every shared line reads as
  // the base's. The view says so for the last two.
  baseRead: "aligned" | "text" | "none";
}

export function baseReadNote(diff: CombinedDiff): string | null {
  if (diff.mode !== "merged") return null;
  if (diff.baseRead === "text") {
    return "The original was too large to align line by line; lines both wrote are marked by their text, and lines both dropped are not shown.";
  }
  if (diff.baseRead === "none") {
    return "The original was not sent, so lines both wrote read as unchanged.";
  }
  return null;
}

export type MergedSegment =
  | { kind: "plain"; lines: string[] }
  | { kind: "conflict"; a: string[]; base: string[]; b: string[] };

const OPEN = /^<{7,}(\s|$)/;
const BASE = /^\|{7,}(\s|$)/;
const SWITCH = /^={7,}$/;
const CLOSE = /^>{7,}(\s|$)/;

// A file's lines, without the phantom empty line a trailing newline would add.
export function fileLines(text: string): string[] {
  const lines = splitIntoLines(text);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /\r?\n$/.test(text)) lines.pop();
  return lines;
}

/**
 * Cuts a merged file at its zdiff3 markers. A region that never closes is not a
 * conflict, just text that happened to start with angle brackets, and is kept
 * as it was.
 */
export function splitConflictRegions(lines: readonly string[]): MergedSegment[] {
  const segments: MergedSegment[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length > 0) segments.push({ kind: "plain", lines: plain });
    plain = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!OPEN.test(line)) {
      plain.push(line);
      index += 1;
      continue;
    }
    // Scan the region; only a well-formed one is cut out.
    const a: string[] = [];
    const base: string[] = [];
    const b: string[] = [];
    let part: "a" | "base" | "b" = "a";
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? "";
      if (part === "a" && BASE.test(current)) part = "base";
      else if (part !== "b" && SWITCH.test(current)) part = "b";
      else if (part === "b" && CLOSE.test(current)) {
        closed = true;
        break;
      } else if (part === "a") a.push(current);
      else if (part === "base") base.push(current);
      else b.push(current);
      cursor += 1;
    }
    if (!closed) {
      plain.push(line);
      index += 1;
      continue;
    }
    flushPlain();
    segments.push({ kind: "conflict", a, base, b });
    index = cursor + 1;
  }
  flushPlain();
  return segments;
}

// Blocks past this many cells are stacked without word-level highlights; a
// conflict that long is read as two versions, not as a rewording.
const CONFLICT_SEGMENT_CELLS = 62_500;

function conflictSegments(
  a: readonly string[],
  b: readonly string[],
): { a: (DiffSegment[] | undefined)[]; b: (DiffSegment[] | undefined)[] } {
  const none = { a: a.map(() => undefined), b: b.map(() => undefined) };
  if (a.length === 0 || b.length === 0 || a.length * b.length > CONFLICT_SEGMENT_CELLS) return none;
  const segA: (DiffSegment[] | undefined)[] = [];
  const segB: (DiffSegment[] | undefined)[] = [];
  for (const line of buildLineDiffFromLines(a, b)) {
    if (line.type === "remove") segA.push(line.segments);
    else if (line.type === "add") segB.push(line.segments);
    else {
      segA.push(undefined);
      segB.push(undefined);
    }
  }
  return segA.length === a.length && segB.length === b.length ? { a: segA, b: segB } : none;
}

// Walks one side's diff against the merge. `take` consumes the entry that
// describes the next merged line; `flushRemoved` yields the lines this side
// still has that the merge dropped, which sit before that entry.
class SideCursor {
  index = 0;
  lineNumber = 1;
  constructor(readonly lines: readonly DiffLine[]) {}

  flushRemoved(): Array<{ line: Omit<CombinedLine, "key">; lineNumber: number }> {
    const removed: Array<{ line: Omit<CombinedLine, "key">; lineNumber: number }> = [];
    while (this.lines[this.index]?.type === "remove") {
      const entry = this.lines[this.index]!;
      removed.push({
        line: { content: entry.content.slice(1), lineA: null, lineB: null, ...segmentsOf(entry) },
        lineNumber: this.lineNumber,
      });
      this.index += 1;
      this.lineNumber += 1;
    }
    return removed;
  }

  take(): { type: "context" | "add"; entry: DiffLine; lineNumber: number | null } | null {
    const entry = this.lines[this.index];
    if (!entry || entry.type === "remove") return null;
    this.index += 1;
    if (entry.type === "context") {
      const lineNumber = this.lineNumber;
      this.lineNumber += 1;
      return { type: "context", entry, lineNumber };
    }
    return { type: "add", entry, lineNumber: null };
  }
}

function segmentsOf(entry: DiffLine): { segments?: DiffSegment[] } {
  return entry.segments ? { segments: entry.segments } : {};
}

export interface CombinedDiffOptions {
  /**
   * The file at the base, to tell a line both sides wrote from a line the
   * base had. Null or omitted when the daemon did not send it; every shared
   * line then reads as the base's.
   */
  base?: string | null;
  budget?: number;
}

function baseLinesOf(options: CombinedDiffOptions): string[] | null {
  return options.base === undefined || options.base === null ? null : fileLines(options.base);
}

// The merge as each input sees it: A's version of every conflict for A, B's
// for B, the base part for the base, plain text for all three.
function mergedTexts(segments: readonly MergedSegment[]) {
  const a: string[] = [];
  const b: string[] = [];
  const base: string[] = [];
  let conflictLines = 0;
  let mergedLines = 0;
  let largestConflict = 0;
  for (const segment of segments) {
    if (segment.kind === "plain") {
      a.push(...segment.lines);
      b.push(...segment.lines);
      base.push(...segment.lines);
      mergedLines += segment.lines.length;
    } else {
      a.push(...segment.a);
      b.push(...segment.b);
      base.push(...segment.base);
      conflictLines += segment.a.length + segment.base.length + segment.b.length;
      mergedLines += segment.a.length + segment.base.length + segment.b.length;
      largestConflict = Math.max(largestConflict, segment.a.length, segment.b.length);
    }
  }
  return { a, b, base, conflictLines, mergedLines, largestConflict };
}

type Taken = ReturnType<SideCursor["take"]>;

// Whether both sides wrote a line they share: the base's alignment says so
// when it is within budget; past it, a line the base never had anywhere is
// theirs and a line it had somewhere reads as the base's, which errs towards
// context; with no base at all, every shared line reads as the base's.
function sharedOrigin(
  content: string,
  fromBase: Taken,
  inBase: ReadonlySet<string> | null,
): "base" | "both" {
  if (fromBase) return fromBase.type === "add" ? "both" : "base";
  if (inBase) return inBase.has(content) ? "base" : "both";
  return "base";
}

// One merged line outside a conflict: A's when only A had to add nothing to
// reach it, B's likewise, otherwise both sides have it and `origin` says
// whether both wrote it.
function plainRow(
  rowKey: string,
  content: string,
  fromA: Taken,
  fromB: Taken,
  origin: "base" | "both",
): CombinedRow {
  const line: CombinedLine = {
    key: rowKey,
    content,
    lineA: fromA?.lineNumber ?? null,
    lineB: fromB?.lineNumber ?? null,
  };
  if (fromA?.type === "context" && fromB?.type === "add") {
    return { key: rowKey, kind: "added", side: "a", line: { ...line, ...segmentsOf(fromB.entry) } };
  }
  if (fromA?.type === "add" && fromB?.type === "context") {
    return { key: rowKey, kind: "added", side: "b", line: { ...line, ...segmentsOf(fromA.entry) } };
  }
  return { key: rowKey, kind: "shared", origin, line };
}

function conflictRow(
  rowKey: string,
  segment: Extract<MergedSegment, { kind: "conflict" }>,
  cursors: { a: SideCursor; b: SideCursor; base: SideCursor | null },
): CombinedRow {
  const segmented = conflictSegments(segment.a, segment.b);
  const a: CombinedLine[] = segment.a.map((content, index) => {
    const fromA = cursors.a.take();
    const segs = segmented.a[index];
    return {
      key: `${rowKey}a${index}`,
      content,
      lineA: fromA?.lineNumber ?? null,
      lineB: null,
      ...(segs ? { segments: segs } : {}),
    };
  });
  const b: CombinedLine[] = segment.b.map((content, index) => {
    const fromB = cursors.b.take();
    const segs = segmented.b[index];
    return {
      key: `${rowKey}b${index}`,
      content,
      lineA: null,
      lineB: fromB?.lineNumber ?? null,
      ...(segs ? { segments: segs } : {}),
    };
  });
  const base: CombinedLine[] = segment.base.map((content, index) => {
    // The conflict's base part is the base's own text; the cursor steps
    // over it to stay in line with the merge.
    cursors.base?.take();
    return { key: `${rowKey}base${index}`, content, lineA: null, lineB: null };
  });
  return { key: rowKey, kind: "conflict", a, base, b };
}

// The lines the merge dropped before its next line: what A still has was
// deleted by B and vice versa; what only the base had was deleted by both. A
// line one side dropped is among the base's removals too and is told apart
// by its text, so one flush never lists it twice.
function removedRows(
  cursors: { a: SideCursor; b: SideCursor; base: SideCursor | null },
  key: () => string,
): CombinedRow[] {
  const rows: CombinedRow[] = [];
  const dropped = new Map<string, number>();
  for (const { line, lineNumber } of cursors.a.flushRemoved()) {
    const rowKey = key();
    rows.push({
      key: rowKey,
      kind: "removed",
      side: "b",
      line: { ...line, key: rowKey, lineA: lineNumber },
    });
    dropped.set(line.content, (dropped.get(line.content) ?? 0) + 1);
  }
  for (const { line, lineNumber } of cursors.b.flushRemoved()) {
    const rowKey = key();
    rows.push({
      key: rowKey,
      kind: "removed",
      side: "a",
      line: { ...line, key: rowKey, lineB: lineNumber },
    });
    dropped.set(line.content, (dropped.get(line.content) ?? 0) + 1);
  }
  for (const { line } of cursors.base?.flushRemoved() ?? []) {
    const count = dropped.get(line.content) ?? 0;
    if (count > 0) {
      dropped.set(line.content, count - 1);
      continue;
    }
    const rowKey = key();
    rows.push({ key: rowKey, kind: "removed", side: "both", line: { ...line, key: rowKey } });
  }
  return rows;
}

function baseReadOf(
  cursorBase: SideCursor | null,
  inBase: ReadonlySet<string> | null,
): CombinedDiff["baseRead"] {
  if (cursorBase) return "aligned";
  if (inBase) return "text";
  return "none";
}

export function buildCombinedDiff(
  merged: string,
  aText: string,
  bText: string,
  options: CombinedDiffOptions = {},
): CombinedDiff {
  const budget = options.budget ?? THREE_WAY_ALIGNMENT_BUDGET;
  const segments = splitConflictRegions(fileLines(merged));
  const texts = mergedTexts(segments);
  const diffA = buildBoundedLineDiff(fileLines(aText).join("\n"), texts.a.join("\n"), budget);
  const diffB = buildBoundedLineDiff(fileLines(bText).join("\n"), texts.b.join("\n"), budget);
  // The base read the same way. Past the budget it says nothing reliable
  // about who wrote a line, so it is left out like a base never sent.
  const baseLines = baseLinesOf(options);
  const diffBase =
    baseLines === null
      ? null
      : buildBoundedLineDiff(baseLines.join("\n"), texts.base.join("\n"), budget);
  const cursors = {
    a: new SideCursor(diffA.lines),
    b: new SideCursor(diffB.lines),
    base: diffBase?.aligned ? new SideCursor(diffBase.lines) : null,
  };
  // Past the budget the base still says which lines it never had. A and B
  // can align for free (both equal to the merge) while the base cannot, so
  // this fallback is what keeps work the two did alike from reading as
  // unchanged on a file both rewrote the same way.
  const inBase = baseLines !== null && cursors.base === null ? new Set(baseLines) : null;
  const baseRead = baseReadOf(cursors.base, inBase);

  const rows: CombinedRow[] = [];
  const key = () => `r${rows.length}`;
  const flushRemoved = () => rows.push(...removedRows(cursors, key));

  for (const segment of segments) {
    if (segment.kind === "plain") {
      for (const content of segment.lines) {
        flushRemoved();
        const fromA = cursors.a.take();
        const fromB = cursors.b.take();
        const fromBase = cursors.base?.take() ?? null;
        rows.push(plainRow(key(), content, fromA, fromB, sharedOrigin(content, fromBase, inBase)));
      }
      continue;
    }
    flushRemoved();
    rows.push(conflictRow(key(), segment, cursors));
  }
  flushRemoved();

  return {
    rows,
    mode: "merged",
    aligned: diffA.aligned && diffB.aligned,
    conflictLines: texts.conflictLines,
    mergedLines: texts.mergedLines,
    largestConflict: texts.largestConflict,
    baseRead,
  };
}

/**
 * A against B, the base left out. For a file both sides rewrote, the merge is
 * one conflict block the length of the file and stacking its two versions makes
 * the reader scroll past one to reach the other; what they differ on is a plain
 * two-way diff between the results. Lines only A has are A's, lines only B has
 * are B's, and a line both have is shown once.
 */
export function buildDirectDiff(
  aText: string,
  bText: string,
  options: CombinedDiffOptions = {},
): CombinedDiff {
  const budget = options.budget ?? THREE_WAY_ALIGNMENT_BUDGET;
  const diff = buildBoundedLineDiff(
    fileLines(aText).join("\n"),
    fileLines(bText).join("\n"),
    budget,
  );
  // With the base out of the alignment, a line both have that the base never
  // had anywhere is one both wrote; a line the base had somewhere reads as
  // the base's, which errs towards context.
  const baseLines = baseLinesOf(options);
  const inBase = baseLines === null ? null : new Set(baseLines);
  const rows: CombinedRow[] = [];
  let lineA = 1;
  let lineB = 1;
  for (const entry of diff.lines) {
    const key = `r${rows.length}`;
    const content = entry.content.slice(1);
    if (entry.type === "context") {
      const origin = inBase !== null && !inBase.has(content) ? "both" : "base";
      rows.push({ key, kind: "shared", origin, line: { key, content, lineA, lineB } });
      lineA += 1;
      lineB += 1;
    } else if (entry.type === "remove") {
      rows.push({
        key,
        kind: "added",
        side: "a",
        line: { key, content, lineA, lineB: null, ...segmentsOf(entry) },
      });
      lineA += 1;
    } else if (entry.type === "add") {
      rows.push({
        key,
        kind: "added",
        side: "b",
        line: { key, content, lineA: null, lineB, ...segmentsOf(entry) },
      });
      lineB += 1;
    }
  }
  return {
    rows,
    mode: "direct",
    aligned: diff.aligned,
    conflictLines: 0,
    mergedLines: rows.length,
    largestConflict: 0,
    baseRead: inBase === null ? "none" : "text",
  };
}

// Collapsing fewer rows than this saves less than the band that replaces them.
const MIN_COLLAPSED_ROWS = 6;

export type CombinedBlock = { kind: "rows"; key: string; rows: CombinedRow[] } | ThreeWayGapBlock;

export type FoldedRange =
  | { kind: "rows"; key: string; start: number; end: number }
  | ThreeWayGapBlock;

/**
 * Folds runs of unchanged rows behind an expander, keeping a few lines of
 * context around every change. A file with no change at all is shown whole.
 * Works on the change flags alone, so every row shape folds the same way.
 */
export function foldRows(
  changed: readonly boolean[],
  revealed: ReadonlySet<number>,
  contextLines: number = THREE_WAY_CONTEXT_LINES,
): FoldedRange[] {
  const total = changed.length;
  if (!changed.some(Boolean))
    return total > 0 ? [{ kind: "rows", key: "rows-0", start: 0, end: total }] : [];
  const visible = changed.map((_, index) => revealed.has(index));
  for (let index = 0; index < total; index += 1) {
    if (!changed[index]) continue;
    for (
      let near = Math.max(0, index - contextLines);
      near <= Math.min(total - 1, index + contextLines);
      near += 1
    ) {
      visible[near] = true;
    }
  }
  // Short hidden runs are shown rather than folded.
  let index = 0;
  while (index < total) {
    if (visible[index]) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < total && !visible[end]) end += 1;
    if (end - index < MIN_COLLAPSED_ROWS)
      for (let fill = index; fill < end; fill += 1) visible[fill] = true;
    index = end;
  }
  const ranges: FoldedRange[] = [];
  index = 0;
  while (index < total) {
    const start = index;
    if (visible[index]) {
      while (index < total && visible[index]) index += 1;
      ranges.push({ kind: "rows", key: `rows-${start}`, start, end: index });
    } else {
      while (index < total && !visible[index]) index += 1;
      ranges.push({ kind: "gap", key: `gap-${start}`, start, end: index, count: index - start });
    }
  }
  return ranges;
}

export function buildCombinedBlocks(
  rows: readonly CombinedRow[],
  revealed: ReadonlySet<number>,
  contextLines: number = THREE_WAY_CONTEXT_LINES,
): CombinedBlock[] {
  return foldRows(
    rows.map((row) => row.kind !== "shared" || row.origin === "both"),
    revealed,
    contextLines,
  ).map((range) =>
    range.kind === "gap"
      ? range
      : { kind: "rows", key: range.key, rows: rows.slice(range.start, range.end) },
  );
}
