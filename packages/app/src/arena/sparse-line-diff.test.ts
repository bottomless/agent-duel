import { describe, expect, it } from "vitest";
import { buildLineDiffFromLines } from "@/utils/tool-call-parsers";
import { buildSparseLineDiff } from "./sparse-line-diff";

describe("buildSparseLineDiff", () => {
  it("aligns an 8k-line block move without allocating a 64M-cell matrix", () => {
    const base = Array.from({ length: 8000 }, (_, index) => `line_${index}`);
    const other = [...base.slice(4000), ...base.slice(0, 4000)];
    const started = performance.now();
    const diff = buildSparseLineDiff(base, other, 1_500_000);
    expect(performance.now() - started).toBeLessThan(1000);
    if (!diff) throw new Error("The sparse block move exceeded the budget");
    expect(diff.filter((line) => line.type === "context")).toHaveLength(4000);
    expect(diff.filter((line) => line.type === "remove")).toHaveLength(4000);
    expect(diff.filter((line) => line.type === "add")).toHaveLength(4000);
  });

  it("keeps line order and duplicate counts when the same text is inserted again", () => {
    expect(buildSparseLineDiff(["x", "keep"], ["x", "x", "keep"], 3)).toEqual([
      { type: "context", content: " x" },
      { type: "add", content: "+x" },
      { type: "context", content: " keep" },
    ]);
  });

  it("bounds matching work for repetitive input before building a traceback", () => {
    const base = Array.from({ length: 1300 }, () => "repeated");
    expect(buildSparseLineDiff(base, base, 1_500_000)).toBeNull();
  });

  it("stays responsive near the repeated-line pair limit", () => {
    const repeated = Array.from({ length: 1200 }, () => "repeat");
    const started = performance.now();
    const diff = buildSparseLineDiff(["a", ...repeated, "b"], ["b", ...repeated, "a"], 1_500_000);
    expect(performance.now() - started).toBeLessThan(1000);
    if (!diff) throw new Error("The comparison was inside the pair budget");
    expect(diff.filter((line) => line.type === "context")).toHaveLength(1200);
    expect(diff.filter((line) => line.type !== "context")).toHaveLength(4);
  });

  it("shows a complete rewrite without spending matching work on unrelated lines", () => {
    expect(buildSparseLineDiff(["old", "old"], ["new", "new"], 0)).toEqual([
      { type: "remove", content: "-old" },
      { type: "remove", content: "-old" },
      { type: "add", content: "+new" },
      { type: "add", content: "+new" },
    ]);
  });

  it("reconstructs both inputs with the minimum edits, including repeated and empty lines", () => {
    const inputs: string[][] = [[]];
    let level: string[][] = [[]];
    for (let length = 1; length <= 4; length += 1) {
      level = level.flatMap((prefix) => [
        [...prefix, ""],
        [...prefix, "x"],
      ]);
      inputs.push(...level);
    }
    for (const base of inputs) {
      for (const other of inputs) {
        const actual = buildSparseLineDiff(base, other, 16);
        if (!actual) throw new Error("Small input exceeded the pair budget");
        expect(
          actual.filter((line) => line.type !== "add").map((line) => line.content.slice(1)),
        ).toEqual(base);
        expect(
          actual.filter((line) => line.type !== "remove").map((line) => line.content.slice(1)),
        ).toEqual(other);
        const reference = buildLineDiffFromLines(base, other);
        expect(actual.filter((line) => line.type !== "context")).toHaveLength(
          reference.filter((line) => line.type !== "context").length,
        );
      }
    }
  });
});
