import type {
  ArenaComparisonDiff,
  ArenaDivergenceFile,
  ArenaThreeWayFile,
} from "@getpaseo/protocol/arena/rpc-schemas";

export function fileContent(text: string) {
  return { content: text, truncated: false, missing: false };
}

export function threeWayFile(input: {
  file: string;
  base: string;
  a: string;
  b: string;
}): ArenaThreeWayFile {
  return {
    file: input.file,
    binary: false,
    additionsA: 1,
    deletionsA: 0,
    additionsB: 1,
    deletionsB: 0,
    base: fileContent(input.base),
    a: fileContent(input.a),
    b: fileContent(input.b),
  };
}

export function comparisonDiff(input: {
  files: ArenaThreeWayFile[];
  divergence: ArenaDivergenceFile[];
  treesEqual?: boolean;
}): ArenaComparisonDiff {
  return {
    turnID: "turn-1",
    baseCommit: "base",
    a: { commit: "a", tree: "tree-a" },
    b: { commit: "b", tree: "tree-b" },
    treesEqual: input.treesEqual ?? false,
    files: input.files,
    filesTruncated: false,
    patch: "",
    truncated: false,
    stats: [],
    divergence: { mergeTree: "tree-merged", conflicted: true, files: input.divergence },
  };
}

const lines = (...items: string[]) => items.join("\n") + "\n";

/** `main.py` where A and B each replaced the middle line differently. */
export function shortConflict() {
  const base = lines("x = 1", "y = 2", "z = 3");
  const a = lines("x = 1", "y = 20", "z = 3");
  const b = lines("x = 1", "y = 200", "z = 3");
  const merged = lines(
    "x = 1",
    "<<<<<<< a",
    "y = 20",
    "||||||| base",
    "y = 2",
    "=======",
    "y = 200",
    ">>>>>>> b",
    "z = 3",
  );
  return comparisonDiff({
    files: [threeWayFile({ file: "main.py", base, a, b })],
    divergence: [{ file: "main.py", status: "diverging", merged: fileContent(merged) }],
  });
}

/** `main.py` where A and B each rewrote the whole file, past a screen of the card. */
export function rewrite() {
  const count = 40;
  const base = lines("x = 0");
  const aLines = Array.from({ length: count }, (_, index) => `a_${index} = ${index}`);
  const bLines = Array.from({ length: count }, (_, index) => `b_${index} = ${index}`);
  const merged = lines(
    "<<<<<<< a",
    ...aLines,
    "||||||| base",
    "x = 0",
    "=======",
    ...bLines,
    ">>>>>>> b",
  );
  return comparisonDiff({
    files: [threeWayFile({ file: "main.py", base, a: lines(...aLines), b: lines(...bLines) })],
    divergence: [{ file: "main.py", status: "diverging", merged: fileContent(merged) }],
  });
}

/** `main.py` where both produced the same file. */
export function sameResult() {
  const text = lines("x = 1", "y = 2");
  return comparisonDiff({
    files: [threeWayFile({ file: "main.py", base: lines("x = 1"), a: text, b: text })],
    divergence: [{ file: "main.py", status: "identical" }],
  });
}

/**
 * `main.py` where both changed every one of 1300 lines the same way: A and B
 * align with the merge for free while the base exceeds the matrix budget.
 */
export function sameResultPastBudget() {
  const count = 1300;
  const base = lines(...Array.from({ length: count }, (_, i) => `line ${i}`));
  const text = lines(...Array.from({ length: count }, (_, i) => `changed ${i}`));
  return comparisonDiff({
    files: [threeWayFile({ file: "main.py", base, a: text, b: text })],
    divergence: [{ file: "main.py", status: "identical" }],
  });
}
