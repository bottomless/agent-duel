import { describe, expect, it } from "vitest";
import {
  buildThreeWayBlocks,
  buildThreeWayDiff,
  buildWindowedThreeWayDiff,
  frameChangedRuns,
  isUnchangedRow,
  limitThreeWayBlocks,
  visibleThreeWayRows,
  visibleThreeWayView,
  type ThreeWayBlock,
  type ThreeWayMode,
  type ThreeWayRow,
} from "./three-way-diff";

const NO_REVEALS: ReadonlySet<number> = new Set<number>();

function threeWayRows(baseText: string, aText: string, bText: string): ThreeWayRow[] {
  return buildThreeWayDiff(baseText, aText, bText).rows;
}

function lines(count: number, prefix = "L"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join("\n");
}

// Compresses a run of frames to one character per row: "." unchanged, "[" the first
// row of a changed run, "]" the last, "|" inside one, "o" a run of exactly one row.
function frameMarks(rows: readonly ThreeWayRow[], mode: ThreeWayMode = "both"): string[] {
  return frameChangedRuns(rows, mode).map((frame) => {
    if (!frame.changed) return ".";
    if (frame.runStart) return frame.runEnd ? "o" : "[";
    return frame.runEnd ? "]" : "|";
  });
}

function shape(blocks: ThreeWayBlock[]): string[] {
  return blocks.map((block) => {
    if (block.kind === "gap") return `gap(${block.count})`;
    if (block.kind === "omitted") return `omitted(${block.lines})`;
    return `rows(${block.rows.length})`;
  });
}

describe("buildThreeWayDiff", () => {
  it("aligns matching insertions when one agent adds extra lines around them", () => {
    const rows = threeWayRows(
      "start\nend",
      "start\nextra A\nshared\nend",
      "start\nshared\nextra B\nend",
    );
    expect(rows.map((row) => [row.a?.content ?? null, row.b?.content ?? null])).toEqual([
      ["start", "start"],
      ["extra A", null],
      ["shared", "shared"],
      [null, "extra B"],
      ["end", "end"],
    ]);
    expect(rows[2]?.a).toMatchObject({ type: "add", lineNumber: 3 });
    expect(rows[2]?.b).toMatchObject({ type: "add", lineNumber: 2 });
  });

  it("aligns an unchanged file identically across all three columns", () => {
    const text = "L1\nL2\nL3";
    const rows = threeWayRows(text, text, text);
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row.base).toEqual({ lineNumber: index + 1, content: `L${index + 1}` });
      expect(row.a).toEqual({ type: "context", content: `L${index + 1}`, lineNumber: index + 1 });
      expect(row.b).toEqual({ type: "context", content: `L${index + 1}`, lineNumber: index + 1 });
    }
  });

  it("places a B-only removal and insertion at the correct row relative to base and A", () => {
    const base = "L1\nL2\nL3";
    const a = "L1\nL2\nL3";
    const b = "L1\nX\nL3";
    const rows = threeWayRows(base, a, b);
    expect(rows).toHaveLength(4);

    expect(rows[0]).toMatchObject({
      base: { lineNumber: 1, content: "L1" },
      a: { type: "context", content: "L1" },
      b: { type: "context", content: "L1" },
    });
    expect(rows[1]).toMatchObject({
      base: { lineNumber: 2, content: "L2" },
      a: { type: "context", content: "L2" },
      b: { type: "remove", content: "L2" },
    });
    expect(rows[2]).toMatchObject({
      base: null,
      a: null,
      b: { type: "add", content: "X", lineNumber: 2 },
    });
    expect(rows[3]).toMatchObject({
      base: { lineNumber: 3, content: "L3" },
      a: { type: "context", content: "L3" },
      b: { type: "context", content: "L3" },
    });
  });

  it("shows an A-added file as pure insertions against an empty base", () => {
    const rows = threeWayRows("", "new1\nnew2", "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      base: null,
      a: { type: "add", content: "new1", lineNumber: 1 },
      b: null,
    });
    expect(rows[1]).toMatchObject({
      base: null,
      a: { type: "add", content: "new2", lineNumber: 2 },
      b: null,
    });
  });

  it("shows a file both sides deleted as all-removed against base with nothing in A or B", () => {
    const rows = threeWayRows("L1\nL2", "", "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      base: { lineNumber: 1, content: "L1" },
      a: { type: "remove", content: "L1", lineNumber: null },
      b: { type: "remove", content: "L1", lineNumber: null },
    });
  });

  it("keeps independent insertions from each side on separate rows at the same anchor", () => {
    const base = "L1\nL2";
    const a = "L1\nAX\nL2";
    const b = "L1\nBX\nBY\nL2";
    const rows = threeWayRows(base, a, b);
    // L1 anchor, [A insert AX / B insert BX], [B insert BY], L2 anchor
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ base: { lineNumber: 1, content: "L1" } });
    expect(rows[1]).toMatchObject({
      base: null,
      a: { type: "add", content: "AX" },
      b: { type: "add", content: "BX" },
    });
    expect(rows[2]).toMatchObject({ base: null, a: null, b: { type: "add", content: "BY" } });
    expect(rows[3]).toMatchObject({ base: { lineNumber: 2, content: "L2" } });
  });
});

describe("frameChangedRuns", () => {
  function marks(base: string, a: string, b: string): string[] {
    return frameMarks(threeWayRows(base, a, b));
  }

  it("marks a lone changed row as both the start and the end of its run", () => {
    expect(marks("L1\nL2\nL3", "L1\nL3", "L1\nL3")).toEqual([".", "o", "."]);
  });

  it("frames a multi-row run once, not once per row", () => {
    const base = "L1\nL2\nL3\nL4";
    expect(marks(base, "L1\nX\nY\nL4", "L1\nX\nY\nL4")).toEqual([".", "[", "|", "|", "]", "."]);
  });

  it("frames two runs separated by context independently", () => {
    const base = "L1\nL2\nL3\nL4\nL5";
    expect(marks(base, "X\nL2\nL3\nL4\nY", "X\nL2\nL3\nL4\nY")).toEqual([
      "[",
      "]",
      ".",
      ".",
      ".",
      "[",
      "]",
    ]);
  });

  it("frames a run that runs from the first row to the last", () => {
    expect(marks("L1\nL2", "X\nY", "X\nY")).toEqual(["[", "|", "|", "]"]);
  });

  it("leaves an unchanged file with no frames at all", () => {
    expect(marks("L1\nL2\nL3", "L1\nL2\nL3", "L1\nL2\nL3")).toEqual([".", ".", "."]);
  });

  it("bands a row only one side changed, so the untouched side is framed too", () => {
    const frames = frameChangedRuns(threeWayRows("L1\nL2\nL3", "L1\nL2\nL3", "L1\nX\nL3"));
    expect(frames.map((frame) => frame.changed)).toEqual([false, true, true, false]);
    expect(frames[1]).toEqual({ changed: true, runStart: true, runEnd: false });
    expect(frames[2]).toEqual({ changed: true, runStart: false, runEnd: true });
  });
});

describe("buildThreeWayBlocks", () => {
  it("collapses a long unchanged file down to the change plus its context", () => {
    const base = lines(100);
    const edited = base.replace("L50", "CHANGED");
    const rows = threeWayRows(base, edited, edited);
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);

    // gap(46) | L47..L49 + remove L50 + add CHANGED + L51..L53 | gap(47)
    expect(shape(blocks)).toEqual(["gap(46)", "rows(8)", "gap(47)"]);
    const gapRowCount = blocks.reduce(
      (sum, block) => sum + (block.kind === "gap" ? block.count : 0),
      0,
    );
    expect(gapRowCount + 8).toBe(rows.length);
  });

  it("keeps every row when a change touches each line, so nothing is hidden", () => {
    const rows = threeWayRows(lines(10), lines(10, "X"), lines(10, "Y"));
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);
    expect(blocks.every((block) => block.kind === "rows")).toBe(true);
  });

  it("shows a short run between two changes instead of collapsing it", () => {
    const base = lines(30);
    const edited = base.replace("L10", "A10").replace("L18", "A18");
    const rows = threeWayRows(base, edited, edited);
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);
    // The rows between the two changes stay visible: one contiguous run, not two.
    expect(blocks.filter((block) => block.kind === "rows")).toHaveLength(1);
  });

  it("keeps a change at the top and one at the bottom visible with a single gap between", () => {
    const baseLines = Array.from({ length: 200 }, (_, index) => `L${index + 1}`);
    const editedLines = [...baseLines];
    editedLines[1] = "TOP CHANGE";
    editedLines[198] = "BOTTOM CHANGE";
    const rows = threeWayRows(baseLines.join("\n"), editedLines.join("\n"), editedLines.join("\n"));
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);

    expect(blocks.map((block) => block.kind)).toEqual(["rows", "gap", "rows"]);
    const [head, , tail] = blocks;
    if (head.kind !== "rows" || tail.kind !== "rows") throw new Error("expected rows blocks");

    const headText = head.rows.flatMap((row) => [row.a?.content, row.b?.content]);
    const tailText = tail.rows.flatMap((row) => [row.a?.content, row.b?.content]);
    expect(headText).toContain("TOP CHANGE");
    expect(headText).toContain("L2");
    expect(tailText).toContain("BOTTOM CHANGE");
    expect(tailText).toContain("L199");
    // Neither change got buried behind the collapsed middle.
    expect(headText).not.toContain("BOTTOM CHANGE");
    expect(tailText).not.toContain("TOP CHANGE");
  });

  it("adds no leading or trailing band when the changes sit on the first and last lines", () => {
    const baseLines = Array.from({ length: 60 }, (_, index) => `L${index + 1}`);
    const editedLines = [...baseLines];
    editedLines[0] = "FIRST";
    editedLines[59] = "LAST";
    const rows = threeWayRows(baseLines.join("\n"), editedLines.join("\n"), editedLines.join("\n"));
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);

    expect(blocks[0].kind).toBe("rows");
    expect(blocks[blocks.length - 1].kind).toBe("rows");
    expect(blocks.filter((block) => block.kind === "gap")).toHaveLength(1);
  });

  it("expands only the rows the reader revealed and leaves the rest collapsed", () => {
    const base = lines(100);
    const edited = base.replace("L50", "CHANGED");
    const rows = threeWayRows(base, edited, edited);
    const collapsed = buildThreeWayBlocks(rows, NO_REVEALS);
    const leadingGap = collapsed[0];
    if (leadingGap.kind !== "gap") throw new Error("expected a leading gap");

    const revealed = new Set<number>();
    for (let index = leadingGap.end - 20; index < leadingGap.end; index += 1) revealed.add(index);
    const blocks = buildThreeWayBlocks(rows, revealed);

    expect(shape(blocks)).toEqual(["gap(26)", "rows(28)", "gap(47)"]);
  });

  it("drops the gap entirely once every hidden row has been revealed", () => {
    const base = lines(100);
    const edited = base.replace("L50", "CHANGED");
    const rows = threeWayRows(base, edited, edited);
    const revealed = new Set<number>(rows.map((_, index) => index));
    const blocks = buildThreeWayBlocks(rows, revealed);
    expect(shape(blocks)).toEqual([`rows(${rows.length})`]);
  });
});

describe("hiding one agent", () => {
  // A file both agents touched, in different places: A rewrites L2, B rewrites L4.
  const BASE = "L1\nL2\nL3\nL4\nL5";
  const A = "L1\nAA\nL3\nL4\nL5";
  const B = "L1\nL2\nL3\nBB\nL5";

  it("treats the hidden agent's edits as unchanged, so they collapse away", () => {
    const rows = threeWayRows(BASE, A, B);
    const shown = visibleThreeWayRows(rows, "a");
    const changed = shown.filter((row) => !isUnchangedRow(row, "a"));
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatchObject({ base: { content: "L2" }, a: { type: "remove" } });
    expect(changed[1]).toMatchObject({ base: null, a: { type: "add", content: "AA" } });
  });

  it("drops the rows that exist only because the hidden agent inserted a line", () => {
    const rows = threeWayRows(BASE, A, B);
    // B's inserted "BB" has no base line and no A cell, so nothing is left to draw.
    expect(rows.some((row) => row.base === null && row.a === null && row.b !== null)).toBe(true);
    const shown = visibleThreeWayRows(rows, "a");
    expect(shown.some((row) => row.base === null && row.a === null)).toBe(false);
  });

  it("keeps a row the hidden agent shares with the shown one", () => {
    const rows = threeWayRows("L1\nL2", "L1\nX", "L1\nX");
    const shown = visibleThreeWayRows(rows, "b");
    const changed = shown.filter((row) => !isUnchangedRow(row, "b"));
    expect(changed).toHaveLength(2);
    expect(changed[1]).toMatchObject({ b: { type: "add", content: "X" } });
  });

  it("frames only the runs the shown agent changed", () => {
    const rows = visibleThreeWayRows(threeWayRows(BASE, A, B), "a");
    expect(frameMarks(rows, "a")).toEqual([".", "[", "]", ".", ".", "."]);
  });

  it("collapses a long file down to only the shown agent's hunk", () => {
    const base = lines(40);
    const a = base.replace("L5\n", "AA\n");
    const b = base.replace("L30\n", "BB\n");
    const rowsBoth = threeWayRows(base, a, b);
    expect(shape(buildThreeWayBlocks(rowsBoth, NO_REVEALS, "both"))).toEqual([
      "rows(9)",
      "gap(18)",
      "rows(8)",
      "gap(7)",
    ]);
    const rowsA = visibleThreeWayRows(rowsBoth, "a");
    expect(shape(buildThreeWayBlocks(rowsA, NO_REVEALS, "a"))).toEqual(["rows(9)", "gap(32)"]);
  });

  it("reports a file the shown agent never touched as entirely unchanged", () => {
    const rows = visibleThreeWayRows(threeWayRows("L1\nL2", "L1\nL2", "L1\nX"), "a");
    expect(rows.every((row) => isUnchangedRow(row, "a"))).toBe(true);
  });
});

describe("limitThreeWayBlocks", () => {
  it("caps rendered rows and reports truncation", () => {
    const rows = threeWayRows(lines(50), lines(50, "X"), lines(50, "Y"));
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);
    const limited = limitThreeWayBlocks(blocks, 10);
    const rendered = limited.blocks.reduce(
      (sum, block) => sum + (block.kind === "rows" ? block.rows.length : 0),
      0,
    );
    expect(rendered).toBe(10);
    expect(limited.truncated).toBe(true);
  });

  it("leaves a diff that fits under the cap untouched", () => {
    const base = lines(100);
    const edited = base.replace("L50", "CHANGED");
    const rows = threeWayRows(base, edited, edited);
    const blocks = buildThreeWayBlocks(rows, NO_REVEALS);
    const limited = limitThreeWayBlocks(blocks, 400);
    expect(limited.truncated).toBe(false);
    expect(shape(limited.blocks)).toEqual(shape(blocks));
  });
});

describe("bounded alignment", () => {
  // The cost that matters is the aligner's, not the row count's: a big file with a
  // small edit has to stay cheap, or a lockfile stalls the tab before the row limit
  // downstream ever gets to throw the alignment away.
  it("aligns a large file with a small edit without paying for the untouched lines", () => {
    const base = lines(20_000);
    const edited = base.replace("L10000", "CHANGED");
    const started = performance.now();
    const { rows, aligned } = buildThreeWayDiff(base, edited, base);
    const elapsed = performance.now() - started;

    expect(aligned).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    expect(rows).toHaveLength(20_001);
    expect(rows[9999]).toMatchObject({
      base: { lineNumber: 10_000, content: "L10000" },
      a: { type: "remove", content: "L10000" },
      b: { type: "context", content: "L10000" },
    });
    expect(rows[10_000]).toMatchObject({ base: null, a: { type: "add", content: "CHANGED" } });
  });

  it("keeps every base line exactly once when a file is replaced wholesale", () => {
    const base = lines(6);
    const a = lines(6, "X");
    // Disjoint text needs no equal-line pairs even with a one-cell matrix budget.
    const { rows, aligned } = buildThreeWayDiff(base, a, base, 1);

    expect(aligned).toBe(true);
    expect(rows.filter((row) => row.base !== null).map((row) => row.base?.content)).toEqual(
      Array.from({ length: 6 }, (_, index) => `L${index + 1}`),
    );
    expect(rows.filter((row) => row.a?.type === "add").map((row) => row.a?.content)).toEqual(
      Array.from({ length: 6 }, (_, index) => `X${index + 1}`),
    );
    // The untouched side still aligns against the same base lines.
    expect(rows.filter((row) => row.b?.type === "context")).toHaveLength(6);
  });

  it("still aligns the head and tail it can when the middle blows the budget", () => {
    const base = ["keep1", "keep2", "a", "b", "a", "tail1", "tail2"].join("\n");
    const a = ["keep1", "keep2", "b", "a", "b", "tail1", "tail2"].join("\n");
    const { rows, aligned } = buildThreeWayDiff(base, a, base, 1);

    expect(aligned).toBe(false);
    expect(rows.slice(0, 2).every((row) => row.a?.type === "context")).toBe(true);
    expect(rows.slice(-2).every((row) => row.a?.type === "context")).toBe(true);
  });
});

describe("windowed files", () => {
  const side = (
    content: string,
    regions?: Array<{ start: number; lines: number }>,
    fileLines?: number,
  ) =>
    regions
      ? { content, regions, ...(fileLines === undefined ? {} : { lines: fileLines }) }
      : { content };

  it("numbers lines from the window's own place in the file", () => {
    const { rows, breaks } = buildWindowedThreeWayDiff(
      side("L100\nL101\nL102", [{ start: 100, lines: 3 }]),
      side("L100\nEDITED\nL102", [{ start: 100, lines: 3 }]),
      side("L100\nL101\nL102", [{ start: 100, lines: 3 }]),
    );
    expect(rows[0]?.base).toEqual({ lineNumber: 100, content: "L100" });
    expect(rows[1]?.base).toEqual({ lineNumber: 101, content: "L101" });
    // Nothing precedes the first window here, so there is no break to report before it.
    expect(breaks).toEqual([{ index: 0, lines: 99 }]);
  });

  it("reports the lines between two windows instead of running them together", () => {
    const { rows, breaks } = buildWindowedThreeWayDiff(
      side("L1\nL2\nL900\nL901", [
        { start: 1, lines: 2 },
        { start: 900, lines: 2 },
      ]),
      side("L1\nCHANGED\nL900\nL901", [
        { start: 1, lines: 2 },
        { start: 900, lines: 2 },
      ]),
      side("L1\nL2\nL900\nCHANGED", [
        { start: 1, lines: 2 },
        { start: 900, lines: 2 },
      ]),
    );
    // Rewriting L2 costs two rows -- base L2 removed by A, then A's line added -- so the
    // second window starts at row 3.
    expect(breaks).toEqual([{ index: 3, lines: 897 }]);
    expect(rows[3]?.base?.lineNumber).toBe(900);
  });

  it("never collapses a run across a break, so unsent lines cannot read as context", () => {
    const regions = [
      { start: 1, lines: 4 },
      { start: 500, lines: 4 },
    ];
    const text = "L1\nL2\nL3\nL4\nL500\nL501\nL502\nL503";
    const diff = buildWindowedThreeWayDiff(
      side(text, regions),
      side(text, regions),
      side(text.replace("L502", "EDITED"), regions),
    );
    const view = visibleThreeWayView(diff, "both");
    const blocks = buildThreeWayBlocks(view.rows, NO_REVEALS, "both", 3, view.breaks);
    const omitted = blocks.filter((block) => block.kind === "omitted");
    expect(omitted).toHaveLength(1);
    // The four rows before the break and the four after are separate blocks; no single run
    // of rows spans the 495 lines nobody sent.
    for (const block of blocks) {
      if (block.kind !== "rows") continue;
      const numbers = block.rows.flatMap((row) => (row.base ? [row.base.lineNumber] : []));
      expect(Math.max(...numbers) - Math.min(...numbers)).toBeLessThan(10);
    }
  });

  it("keeps break positions attached to their rows when an agent column is hidden", () => {
    const diff = buildWindowedThreeWayDiff(
      side("L1\nL2\nL80\nL81", [
        { start: 1, lines: 2 },
        { start: 80, lines: 2 },
      ]),
      // A inserts a line in the first window; hiding A drops that row and renumbers the rest.
      side("L1\nINSERTED\nL2\nL80\nL81", [
        { start: 1, lines: 3 },
        { start: 80, lines: 2 },
      ]),
      side("L1\nL2\nL80\nL81", [
        { start: 1, lines: 2 },
        { start: 80, lines: 2 },
      ]),
    );
    const both = visibleThreeWayView(diff, "both");
    const onlyB = visibleThreeWayView(diff, "b");
    expect(both.rows[both.breaks[0]?.index ?? -1]?.base?.lineNumber).toBe(80);
    expect(onlyB.rows[onlyB.breaks[0]?.index ?? -1]?.base?.lineNumber).toBe(80);
    expect(onlyB.rows.length).toBeLessThan(both.rows.length);
  });

  it("names the lines after the last window, which are as unsent as the ones between", () => {
    const regions = [{ start: 10, lines: 2 }];
    const diff = buildWindowedThreeWayDiff(
      side("L10\nL11", regions, 30_042),
      side("L10\nEDITED", regions, 30_042),
      side("L10\nL11", regions, 30_042),
    );
    // 9 lines before the window, and everything from 12 to the end of the file after it.
    expect(diff.breaks).toEqual([
      { index: 0, lines: 9 },
      { index: diff.rows.length, lines: 30_031 },
    ]);
  });

  it("says nothing at the end when the last window runs to the end of the file", () => {
    const regions = [{ start: 10, lines: 2 }];
    const diff = buildWindowedThreeWayDiff(
      side("L10\nL11", regions, 11),
      side("L10\nEDITED", regions, 11),
      side("L10\nL11", regions, 11),
    );
    expect(diff.breaks).toEqual([{ index: 0, lines: 9 }]);
  });

  it("leaves the tail unclaimed when the daemon did not send a line count", () => {
    // An older daemon sends regions without one. Guessing a count would invent a band.
    const regions = [{ start: 10, lines: 2 }];
    const diff = buildWindowedThreeWayDiff(
      side("L10\nL11", regions),
      side("L10\nEDITED", regions),
      side("L10\nL11", regions),
    );
    expect(diff.breaks).toEqual([{ index: 0, lines: 9 }]);
  });

  it("draws a trailing band for a file added this turn and cut short", () => {
    // No base to measure against, so the geometry comes from the agents' own windows.
    const head = [{ start: 1, lines: 2 }];
    const diff = buildWindowedThreeWayDiff(
      side(""),
      side("N1\nN2", head, 900),
      side("N1\nN2", head, 900),
    );
    expect(diff.breaks).toEqual([{ index: diff.rows.length, lines: 898 }]);
    expect(diff.rows[0]?.a?.lineNumber).toBe(1);
  });

  it("treats a file with no regions exactly as before", () => {
    const diff = buildWindowedThreeWayDiff(side("L1\nL2"), side("L1\nX"), side("L1\nL2"));
    expect(diff.breaks).toEqual([]);
    expect(diff.rows).toHaveLength(3);
    expect(diff.rows[0]?.base?.lineNumber).toBe(1);
  });

  it("draws a side that does not have the file as having removed every windowed line", () => {
    const diff = buildWindowedThreeWayDiff(
      side("L10\nL11", [{ start: 10, lines: 2 }]),
      side("L10\nEDITED", [{ start: 10, lines: 2 }]),
      // B deleted the file: no content and no regions. Windows are only ever dropped from
      // every side at once, so a side alone without them is a side without the file.
      side(""),
    );
    expect(diff.rows.filter((row) => row.b?.type === "remove")).toHaveLength(2);
    expect(diff.rows[0]?.a?.content).toBe("L10");
    expect(diff.rows[0]?.base?.lineNumber).toBe(10);
  });
});
