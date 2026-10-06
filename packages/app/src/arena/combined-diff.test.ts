import { describe, expect, it } from "vitest";
import {
  baseReadNote,
  buildCombinedBlocks,
  buildCombinedDiff,
  buildDirectDiff,
  fileLines,
  splitConflictRegions,
  type CombinedRow,
} from "./combined-diff";

const lines = (...items: string[]) => items.join("\n") + "\n";

function summary(rows: readonly CombinedRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "conflict") {
      return `conflict a[${row.a.map((l) => l.content).join("|")}] base[${row.base.map((l) => l.content).join("|")}] b[${row.b.map((l) => l.content).join("|")}]`;
    }
    if (row.kind === "shared") {
      return `${row.origin === "both" ? "both" : "shared"} ${row.line.content}`;
    }
    return `${row.kind} ${row.side} ${row.line.content}`;
  });
}

describe("fileLines", () => {
  it("drops the phantom line after a trailing newline and normalizes CRLF", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(fileLines("a\nb")).toEqual(["a", "b"]);
    expect(fileLines("")).toEqual([]);
    expect(fileLines("\n")).toEqual([""]);
  });
});

describe("splitConflictRegions", () => {
  it("cuts a zdiff3 region into its three parts", () => {
    const segments = splitConflictRegions([
      "top",
      "<<<<<<< a",
      "x = 1",
      "||||||| base",
      "x = 0",
      "=======",
      "x = 2",
      ">>>>>>> b",
      "bottom",
    ]);
    expect(segments).toEqual([
      { kind: "plain", lines: ["top"] },
      { kind: "conflict", a: ["x = 1"], base: ["x = 0"], b: ["x = 2"] },
      { kind: "plain", lines: ["bottom"] },
    ]);
  });

  it("accepts an empty base and a region without a base marker", () => {
    expect(
      splitConflictRegions(["<<<<<<< a", "A", "||||||| base", "=======", "B", ">>>>>>> b"]),
    ).toEqual([{ kind: "conflict", a: ["A"], base: [], b: ["B"] }]);
    expect(splitConflictRegions(["<<<<<<< a", "A", "=======", "B", ">>>>>>> b"])).toEqual([
      { kind: "conflict", a: ["A"], base: [], b: ["B"] },
    ]);
  });

  it("keeps an unterminated region as plain text", () => {
    expect(splitConflictRegions(["<<<<<<< a", "A", "=======", "B"])).toEqual([
      { kind: "plain", lines: ["<<<<<<< a", "A", "=======", "B"] },
    ]);
  });
});

describe("buildCombinedDiff", () => {
  it("shows disjoint edits as each side's own lines", () => {
    const base = lines("1", "2", "3", "4", "5", "6");
    const a = lines("1", "2A", "3", "4", "5", "6");
    const b = lines("1", "2", "3", "4", "5B", "6");
    const merged = lines("1", "2A", "3", "4", "5B", "6");
    const diff = buildCombinedDiff(merged, a, b);
    expect(diff.aligned).toBe(true);
    expect(diff.conflictLines).toBe(0);
    expect(diff.mergedLines).toBe(6);
    expect(summary(diff.rows)).toEqual([
      "shared 1",
      "removed a 2",
      "added a 2A",
      "shared 3",
      "shared 4",
      "removed b 5",
      "added b 5B",
      "shared 6",
    ]);
    // A's replacement of line 2 carries A's numbering; B's original keeps B's.
    expect(diff.rows[1]).toMatchObject({ line: { lineA: null, lineB: 2 } });
    expect(diff.rows[2]).toMatchObject({ line: { lineA: 2, lineB: null } });
    void base;
  });

  it("shows a line one side deleted as removed by that side", () => {
    const a = lines("1", "3");
    const b = lines("1", "2", "3");
    const merged = lines("1", "3");
    expect(summary(buildCombinedDiff(merged, a, b).rows)).toEqual([
      "shared 1",
      "removed a 2",
      "shared 3",
    ]);
  });

  it("numbers each line of a deleted run by its own source line", () => {
    const a = lines("1", "2", "3", "4", "5");
    const b = lines("1", "5");
    const merged = lines("1", "5");
    const rows = buildCombinedDiff(merged, a, b).rows;
    expect(summary(rows)).toEqual([
      "shared 1",
      "removed b 2",
      "removed b 3",
      "removed b 4",
      "shared 5",
    ]);
    const removed = rows.flatMap((row) => (row.kind === "removed" ? [row.line.lineA] : []));
    expect(removed).toEqual([2, 3, 4]);
  });

  it("stacks a conflict with word-level highlights between the two versions", () => {
    const a = lines("def f():", "    return 1");
    const b = lines("def f():", "    return 2");
    const merged = lines(
      "def f():",
      "<<<<<<< a",
      "    return 1",
      "||||||| base",
      "    return 0",
      "=======",
      "    return 2",
      ">>>>>>> b",
    );
    const diff = buildCombinedDiff(merged, a, b);
    expect(summary(diff.rows)).toEqual([
      "shared def f():",
      "conflict a[    return 1] base[    return 0] b[    return 2]",
    ]);
    const conflict = diff.rows[1];
    if (conflict.kind !== "conflict") throw new Error("expected conflict");
    expect(conflict.a[0]).toMatchObject({ lineA: 2, lineB: null });
    expect(conflict.b[0]).toMatchObject({ lineA: null, lineB: 2 });
    expect(conflict.a[0].segments?.some((segment) => segment.changed && segment.text === "1")).toBe(
      true,
    );
    expect(conflict.b[0].segments?.some((segment) => segment.changed && segment.text === "2")).toBe(
      true,
    );
    expect(diff.conflictLines).toBe(3);
    expect(diff.mergedLines).toBe(4);
  });

  it("keeps a closing brace after the region out of the region", () => {
    const a = lines("f() {", "  a();", "}");
    const b = lines("f() {", "  b();", "}");
    const merged = lines("f() {", "<<<<<<< a", "  a();", "=======", "  b();", ">>>>>>> b", "}");
    expect(summary(buildCombinedDiff(merged, a, b).rows)).toEqual([
      "shared f() {",
      "conflict a[  a();] base[] b[  b();]",
      "shared }",
    ]);
  });

  it("reads a file only one side touched as that side's change", () => {
    const base = lines("1", "2");
    const a = lines("1", "1.5", "2");
    // B left the file alone, so B's content is the base and the merge is A's file.
    expect(summary(buildCombinedDiff(a, a, base).rows)).toEqual([
      "shared 1",
      "added a 1.5",
      "shared 2",
    ]);
  });

  it("measures the longest version in any conflict", () => {
    const merged = lines(
      "1",
      "<<<<<<< a",
      "a1",
      "a2",
      "a3",
      "||||||| base",
      "x",
      "=======",
      "b1",
      ">>>>>>> b",
      "2",
      "<<<<<<< a",
      "a4",
      "=======",
      "b2",
      "b3",
      "b4",
      "b5",
      ">>>>>>> b",
    );
    const diff = buildCombinedDiff(
      merged,
      lines("1", "a1", "a2", "a3", "2", "a4"),
      lines("1", "b1", "2", "b2", "b3", "b4", "b5"),
    );
    expect(diff.mode).toBe("merged");
    expect(diff.largestConflict).toBe(4);
    expect(diff.conflictLines).toBe(10);
  });

  it("reports a repetitive file past both alignment budgets as unaligned", () => {
    const a = lines("x", "y", "x");
    const b = lines("y", "x", "y");
    const merged = b;
    expect(buildCombinedDiff(merged, a, b, { budget: 1 }).aligned).toBe(false);
  });
});

describe("buildCombinedDiff against the base", () => {
  it("marks a line both sides added as both, not as context", () => {
    const base = lines("x = 1");
    const a = lines("x = 1", "y = 2");
    expect(summary(buildCombinedDiff(a, a, a, { base }).rows)).toEqual([
      "shared x = 1",
      "both y = 2",
    ]);
  });

  it("reads a file both changed the same way as the change both made", () => {
    const base = lines("def f():", "    return 1", "", "print(f())");
    const both = lines("def f():", "    return 2", "", "print(f())");
    expect(summary(buildCombinedDiff(both, both, both, { base }).rows)).toEqual([
      "shared def f():",
      "removed both     return 1",
      "both     return 2",
      "shared ",
      "shared print(f())",
    ]);
  });

  it("tells a line one side dropped from a line both dropped", () => {
    const base = lines("x = 1", "y = 2", "z = 3", "w = 4");
    const a = lines("x = 1", "z = 3");
    const b = lines("x = 1", "y = 2", "z = 3");
    // git drops what either side dropped: y by A alone, w by both.
    const merged = lines("x = 1", "z = 3");
    expect(summary(buildCombinedDiff(merged, a, b, { base }).rows)).toEqual([
      "shared x = 1",
      "removed a y = 2",
      "shared z = 3",
      "removed both w = 4",
    ]);
  });

  it("keeps each side's own lines while marking the shared addition", () => {
    const base = lines("x = 1");
    const a = lines("x = 1", "y = 2", "a = 0");
    const b = lines("x = 1", "y = 2", "b = 0");
    const merged = lines("x = 1", "y = 2", "a = 0", "b = 0");
    expect(summary(buildCombinedDiff(merged, a, b, { base }).rows)).toEqual([
      "shared x = 1",
      "both y = 2",
      "added a a = 0",
      "added b b = 0",
    ]);
  });

  it("steps over a conflict's base part", () => {
    const base = lines("x = 0", "y = 2");
    const a = lines("x = 1", "y = 2");
    const b = lines("x = 2", "y = 2");
    const merged = lines(
      "<<<<<<< a",
      "x = 1",
      "||||||| base",
      "x = 0",
      "=======",
      "x = 2",
      ">>>>>>> b",
      "y = 2",
    );
    expect(summary(buildCombinedDiff(merged, a, b, { base }).rows)).toEqual([
      "conflict a[x = 1] base[x = 0] b[x = 2]",
      "shared y = 2",
    ]);
  });

  it("reads every shared line as the base's when the base was not sent", () => {
    const a = lines("x = 1", "y = 2");
    expect(summary(buildCombinedDiff(a, a, a).rows)).toEqual(["shared x = 1", "shared y = 2"]);
    expect(summary(buildCombinedDiff(a, a, a, { base: null }).rows)).toEqual([
      "shared x = 1",
      "shared y = 2",
    ]);
  });
});

describe("buildDirectDiff", () => {
  it("reads A against B with the base left out", () => {
    const a = lines("shared", "only a", "same again");
    const b = lines("shared", "only b 1", "only b 2", "same again");
    const diff = buildDirectDiff(a, b);
    expect(diff.mode).toBe("direct");
    expect(summary(diff.rows)).toEqual([
      "shared shared",
      "added a only a",
      "added b only b 1",
      "added b only b 2",
      "shared same again",
    ]);
    expect(
      diff.rows.map((row) => (row.kind === "conflict" ? null : [row.line.lineA, row.line.lineB])),
    ).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [null, 3],
      [3, 4],
    ]);
  });

  it("marks the words two versions of a line differ on", () => {
    const diff = buildDirectDiff(lines("return a + 1"), lines("return a + 2"));
    const rowA = diff.rows[0];
    expect(rowA?.kind === "added" && rowA.line.segments?.some((segment) => segment.changed)).toBe(
      true,
    );
  });
});

describe("buildCombinedDiff past the base's matrix alignment budget", () => {
  it("shows both the shared deletions and additions in a complete rewrite", () => {
    const base = lines("a = 1", "b = 2", "c = 3");
    // A and B equal the merge, so their alignment is free; only the base's
    // exceeds the budget.
    const both = lines("x = 1", "y = 2", "z = 3");
    const diff = buildCombinedDiff(both, both, both, { base, budget: 4 });
    expect(diff.aligned).toBe(true);
    expect(diff.baseRead).toBe("aligned");
    expect(summary(diff.rows)).toEqual([
      "removed both a = 1",
      "removed both b = 2",
      "removed both c = 3",
      "both x = 1",
      "both y = 2",
      "both z = 3",
    ]);
    expect(baseReadNote(diff)).toBeNull();
  });

  it("marks relocated text by its position instead of treating every old string as unchanged", () => {
    const base = lines("a = 1", "b = 2", "c = 3");
    const both = lines("c = 3", "x = 1", "y = 2", "b = 2");
    expect(summary(buildCombinedDiff(both, both, both, { base, budget: 4 }).rows)).toEqual([
      "removed both a = 1",
      "removed both b = 2",
      "shared c = 3",
      "both x = 1",
      "both y = 2",
      "both b = 2",
    ]);
  });

  it("reports how the base was read", () => {
    const a = lines("x = 1");
    expect(buildCombinedDiff(a, a, a, { base: lines("y = 2") }).baseRead).toBe("aligned");
    expect(buildCombinedDiff(a, a, a).baseRead).toBe("none");
    expect(baseReadNote(buildCombinedDiff(a, a, a))).toContain("not sent");
    expect(baseReadNote(buildCombinedDiff(a, a, a, { base: lines("y = 2") }))).toBeNull();
    expect(baseReadNote(buildDirectDiff(a, a))).toBeNull();
  });
});

describe("buildDirectDiff against the base", () => {
  it("marks a line both wrote that the base never had", () => {
    const base = lines("x = 1");
    const a = lines("x = 1", "y = 2", "a = 0");
    const b = lines("x = 1", "y = 2", "b = 0");
    expect(summary(buildDirectDiff(a, b, { base }).rows)).toEqual([
      "shared x = 1",
      "both y = 2",
      "added a a = 0",
      "added b b = 0",
    ]);
  });
});

describe("buildCombinedBlocks", () => {
  it("keeps a line both wrote out of the fold", () => {
    const base = lines(...Array.from({ length: 30 }, (_, i) => `line ${i}`));
    const both = lines(
      ...Array.from({ length: 15 }, (_, i) => `line ${i}`),
      "added by both",
      ...Array.from({ length: 15 }, (_, i) => `line ${i + 15}`),
    );
    const blocks = buildCombinedBlocks(
      buildCombinedDiff(both, both, both, { base }).rows,
      new Set(),
    );
    const shown = blocks.flatMap((block) => (block.kind === "rows" ? block.rows : []));
    expect(shown.map((row) => (row.kind === "conflict" ? "" : row.line.content))).toContain(
      "added by both",
    );
    expect(blocks.some((block) => block.kind === "gap")).toBe(true);
  });

  const shared = (content: string, index: number): CombinedRow => ({
    key: `r${index}`,
    kind: "shared",
    origin: "base",
    line: { key: `r${index}`, content, lineA: index + 1, lineB: index + 1 },
  });

  it("folds long shared runs and keeps context around a change", () => {
    const rows: CombinedRow[] = Array.from({ length: 20 }, (_, index) =>
      shared(`l${index}`, index),
    );
    rows[10] = {
      key: "r10",
      kind: "added",
      side: "a",
      line: { key: "r10", content: "new", lineA: 11, lineB: null },
    };
    const blocks = buildCombinedBlocks(rows, new Set(), 2);
    expect(
      blocks.map((block) =>
        block.kind === "gap" ? `gap ${block.count}` : `rows ${block.rows.length}`,
      ),
    ).toEqual(["gap 8", "rows 5", "gap 7"]);
  });

  it("shows a short hidden run instead of folding it", () => {
    const rows: CombinedRow[] = Array.from({ length: 6 }, (_, index) => shared(`l${index}`, index));
    rows[5] = {
      key: "r5",
      kind: "added",
      side: "b",
      line: { key: "r5", content: "new", lineA: null, lineB: 6 },
    };
    expect(buildCombinedBlocks(rows, new Set(), 1)).toHaveLength(1);
  });

  it("shows a file with no change whole", () => {
    const rows = Array.from({ length: 3 }, (_, index) => shared(`l${index}`, index));
    expect(buildCombinedBlocks(rows, new Set())).toEqual([{ kind: "rows", key: "rows-0", rows }]);
    expect(buildCombinedBlocks([], new Set())).toEqual([]);
  });

  it("honors revealed rows", () => {
    const rows: CombinedRow[] = Array.from({ length: 20 }, (_, index) =>
      shared(`l${index}`, index),
    );
    rows[19] = {
      key: "r19",
      kind: "added",
      side: "a",
      line: { key: "r19", content: "new", lineA: 20, lineB: null },
    };
    const blocks = buildCombinedBlocks(
      rows,
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      2,
    );
    expect(blocks).toHaveLength(1);
  });
});
