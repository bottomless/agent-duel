import { describe, expect, it } from "vitest";
import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaChangesCountLabel, arenaChangesRows } from "./changes-rows";

type ThreeWayFile = NonNullable<ArenaComparisonDiff["files"]>[number];

function file(input: Partial<ThreeWayFile> & { file: string }): ThreeWayFile {
  return {
    binary: false,
    additionsA: 0,
    deletionsA: 0,
    additionsB: 0,
    deletionsB: 0,
    ...input,
  };
}

function diff(input: Partial<ArenaComparisonDiff> = {}): ArenaComparisonDiff {
  return {
    turnID: "turn-1",
    baseCommit: "base",
    a: { commit: "a", tree: "tree-a" },
    b: { commit: "b", tree: "tree-b" },
    treesEqual: false,
    files: [],
    filesTruncated: false,
    patch: "",
    truncated: false,
    stats: [],
    divergence: { mergeTree: "tree-merged", conflicted: false, files: [] },
    ...input,
  };
}

describe("arenaChangesRows", () => {
  it("names which side changed each file from its numstat", () => {
    const rows = arenaChangesRows(
      diff({
        files: [
          file({ file: "primes.py", additionsA: 17, additionsB: 27 }),
          file({ file: "tests/test_primes.py", additionsB: 12 }),
          file({ file: "README.md", additionsA: 2, deletionsA: 1 }),
        ],
      }),
    );
    expect(rows.map((row) => [row.file, row.changedBy])).toEqual([
      ["primes.py", "both"],
      ["tests/test_primes.py", "b"],
      ["README.md", "a"],
    ]);
    expect(rows[0]).toMatchObject({ additionsA: 17, deletionsA: 0, additionsB: 27, deletionsB: 0 });
  });

  it("attributes a binary file to both sides, since numstat cannot say", () => {
    const rows = arenaChangesRows(diff({ files: [file({ file: "logo.png", binary: true })] }));
    expect(rows).toEqual([
      expect.objectContaining({ file: "logo.png", binary: true, changedBy: "both" }),
    ]);
  });

  it("keeps shared changes when both agents produced identical trees", () => {
    const rows = arenaChangesRows(
      diff({
        treesEqual: true,
        files: [file({ file: "main.py", additionsA: 10, additionsB: 10 })],
        divergence: {
          mergeTree: "shared-result",
          conflicted: false,
          files: [{ file: "main.py", status: "identical" }],
        },
      }),
    );
    expect(rows).toEqual([
      {
        file: "main.py",
        binary: false,
        additionsA: 10,
        deletionsA: 0,
        additionsB: 10,
        deletionsB: 0,
        changedBy: "both",
        status: "identical",
      },
    ]);
  });

  it("is empty when neither agent changed a file or the diff is missing", () => {
    expect(arenaChangesRows(undefined)).toEqual([]);
    expect(arenaChangesRows(diff({ treesEqual: true }))).toEqual([]);
  });
});

describe("arenaChangesCountLabel", () => {
  it("pluralizes", () => {
    expect(arenaChangesCountLabel(1)).toBe("1 file");
    expect(arenaChangesCountLabel(4)).toBe("4 files");
  });
});
