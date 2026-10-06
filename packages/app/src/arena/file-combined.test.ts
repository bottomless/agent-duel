// @vitest-environment node
import { describe, expect, it } from "vitest";
import { baseReadNote } from "./combined-diff";
import { combinedDiffFor } from "./file-combined";
import { threeWayFile } from "./review-fixtures.test-helpers";

describe("combinedDiffFor", () => {
  it("shows a shared reorder as removals and additions beyond the matrix alignment budget", () => {
    const lines = Array.from({ length: 1300 }, (_, index) => `line_${index}`);
    const base = lines.join("\n");
    const result = [...lines.slice(650), ...lines.slice(0, 650)].join("\n");
    const file = threeWayFile({ file: "example.txt", base, a: result, b: result });
    const diff = combinedDiffFor(file, { file: file.file, status: "identical" });

    expect(diff).not.toBeNull();
    if (!diff) throw new Error("The card discarded the shared reorder");
    expect(diff.aligned).toBe(true);
    expect(diff.baseRead).toBe("aligned");
    const removed = diff.rows
      .filter((row) => row.kind === "removed")
      .filter((row) => row.side === "both");
    const added = diff.rows
      .filter((row) => row.kind === "shared")
      .filter((row) => row.origin === "both");
    expect(removed).toHaveLength(650);
    expect(added).toHaveLength(650);
    expect(added.map((row) => row.line.content)).toEqual(removed.map((row) => row.line.content));
    expect(baseReadNote(diff)).toBeNull();
  });

  it("keeps the no-diff result when both files match the fully aligned base", () => {
    const file = threeWayFile({ file: "example.txt", base: "same", a: "same", b: "same" });
    expect(combinedDiffFor(file, { file: file.file, status: "identical" })).toBeNull();
  });

  it("retains the limitation notice when repeated lines exceed both work budgets", () => {
    const repeated = Array.from({ length: 1300 }, () => "repeat");
    const base = ["moved", ...repeated].join("\n");
    const result = [...repeated, "moved"].join("\n");
    const file = threeWayFile({ file: "example.txt", base, a: result, b: result });
    const diff = combinedDiffFor(file, { file: file.file, status: "identical" });
    if (!diff) throw new Error("The card discarded the base comparison limitation");
    expect(diff.baseRead).toBe("text");
    expect(baseReadNote(diff)).toContain("too large to align line by line");
  });
});
