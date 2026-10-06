import { describe, expect, it } from "vitest";
import { buildCombinedDiff, buildDirectDiff } from "./combined-diff";
import { buildSplitBlocks, buildSplitRows, type SplitRow } from "./split-rows";

const lines = (...items: string[]) => items.join("\n") + "\n";

function cell(row: SplitRow, side: "a" | "b"): string {
  const value = row[side];
  if (value.kind === "empty") return "·";
  const number = value.lineNumber ?? "-";
  return `${value.kind[0]}${number}:${value.content}`;
}

function summary(rows: readonly SplitRow[]): string[] {
  return rows.map((row) => `${cell(row, "a")} | ${cell(row, "b")}`);
}

describe("buildSplitRows", () => {
  it("puts a line one side wrote in that side's column, facing an empty cell", () => {
    const a = lines("1", "a", "2");
    const b = lines("1", "2", "b");
    const merged = lines("1", "a", "2", "b");
    expect(summary(buildSplitRows(buildCombinedDiff(merged, a, b)))).toEqual([
      "c1:1 | c1:1",
      "c2:a | ·",
      "c3:2 | c2:2",
      "· | c3:b",
    ]);
  });

  it("strikes a line the side dropped while the other column keeps it", () => {
    const a = lines("1", "3");
    const b = lines("1", "2", "3");
    const merged = lines("1", "3");
    expect(summary(buildSplitRows(buildCombinedDiff(merged, a, b)))).toEqual([
      "c1:1 | c1:1",
      "r-:2 | c2:2",
      "c2:3 | c3:3",
    ]);
  });

  it("faces the two versions of a conflict line by line with the words marked", () => {
    const a = lines("x", "return a + 1", "y");
    const b = lines("x", "return a + 2", "extra", "y");
    const merged = lines(
      "x",
      "<<<<<<< a",
      "return a + 1",
      "=======",
      "return a + 2",
      "extra",
      ">>>>>>> b",
      "y",
    );
    const rows = buildSplitRows(buildCombinedDiff(merged, a, b));
    expect(summary(rows)).toEqual([
      "c1:x | c1:x",
      "c2:return a + 1 | c2:return a + 2",
      "· | c3:extra",
      "c3:y | c4:y",
    ]);
    const paired = rows[1]!;
    expect(paired.a.kind === "changed" && paired.a.segments?.some((s) => s.changed)).toBe(true);
    expect(paired.b.kind === "changed" && paired.b.segments?.some((s) => s.changed)).toBe(true);
  });

  it("reads a line both versions share as shared", () => {
    const a = lines("only a", "same", "a2");
    const b = lines("only b", "same", "b2");
    const merged = lines(
      "<<<<<<< a",
      "only a",
      "same",
      "a2",
      "=======",
      "only b",
      "same",
      "b2",
      ">>>>>>> b",
    );
    const rows = buildSplitRows(buildCombinedDiff(merged, a, b));
    expect(summary(rows)).toEqual(["c1:only a | c1:only b", "c2:same | c2:same", "c3:a2 | c3:b2"]);
    expect(rows.map((row) => row.shared)).toEqual([false, true, false]);
  });

  it("pairs the two sides of a rewrite the way a split diff does", () => {
    const a = lines("shared", "a only", "same again");
    const b = lines("shared", "b only 1", "b only 2", "same again");
    expect(summary(buildSplitRows(buildDirectDiff(a, b)))).toEqual([
      "c1:shared | c1:shared",
      "c2:a only | c2:b only 1",
      "· | c3:b only 2",
      "c3:same again | c4:same again",
    ]);
  });
});

describe("buildSplitRows against the base", () => {
  it("marks a line both wrote in both columns and strikes a line both dropped in both", () => {
    const base = lines("x = 1", "y = 2");
    const both = lines("x = 1", "z = 3");
    expect(summary(buildSplitRows(buildCombinedDiff(both, both, both, { base })))).toEqual([
      "c1:x = 1 | c1:x = 1",
      "r-:y = 2 | r-:y = 2",
      "b2:z = 3 | b2:z = 3",
    ]);
  });

  it("does not fold a line both wrote", () => {
    const base = lines(...Array.from({ length: 30 }, (_, i) => `line ${i}`));
    const both = lines(
      ...Array.from({ length: 15 }, (_, i) => `line ${i}`),
      "added by both",
      ...Array.from({ length: 15 }, (_, i) => `line ${i + 15}`),
    );
    const rows = buildSplitRows(buildCombinedDiff(both, both, both, { base }));
    const blocks = buildSplitBlocks(rows, new Set());
    const shown = blocks.flatMap((block) => (block.kind === "rows" ? block.rows : []));
    expect(shown.some((row) => row.a.kind === "both")).toBe(true);
    expect(blocks.some((block) => block.kind === "gap")).toBe(true);
  });
});

describe("buildSplitBlocks", () => {
  it("folds long shared runs and keeps context around a change", () => {
    const a = lines(...Array.from({ length: 30 }, (_, i) => `l${i}`));
    const b = lines(...Array.from({ length: 30 }, (_, i) => (i === 15 ? "changed" : `l${i}`)));
    const merged = b;
    const rows = buildSplitRows(buildCombinedDiff(merged, a, b));
    const blocks = buildSplitBlocks(rows, new Set());
    expect(blocks.map((block) => block.kind)).toEqual(["gap", "rows", "gap"]);
    const middle = blocks[1];
    expect(middle?.kind === "rows" && middle.rows.length).toBe(8);
  });
});
