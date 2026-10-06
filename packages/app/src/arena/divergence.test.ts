import { describe, expect, it } from "vitest";
import type {
  ArenaComparisonDiff,
  ArenaDivergenceFile,
  ArenaThreeWayFile,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { divergenceByFile, divergenceStatusLabel, mergedContent } from "./divergence";

function content(text: string, extra: Partial<ArenaThreeWayFile["a"]> = {}) {
  return { content: text, truncated: false, missing: false, ...extra };
}

function file(input: Partial<ArenaThreeWayFile> = {}): ArenaThreeWayFile {
  return {
    file: "main.py",
    binary: false,
    additionsA: 1,
    deletionsA: 0,
    additionsB: 1,
    deletionsB: 0,
    base: content("base\n"),
    a: content("a\n"),
    b: content("b\n"),
    ...input,
  };
}

function entry(input: Partial<ArenaDivergenceFile> = {}): ArenaDivergenceFile {
  return { file: "main.py", status: "diverging", ...input };
}

describe("divergenceByFile", () => {
  it("indexes entries by path", () => {
    const diff = {
      divergence: { mergeTree: "t", conflicted: true, files: [entry(), entry({ file: "x" })] },
    } as ArenaComparisonDiff;
    expect(divergenceByFile(diff).get("x")?.file).toBe("x");
    expect(divergenceByFile(undefined).size).toBe(0);
  });
});

describe("mergedContent", () => {
  it("reads git's merge for files both sides touched", () => {
    const merged = content("<<<<<<< a\na\n=======\nb\n>>>>>>> b\n");
    expect(mergedContent(file(), entry({ status: "diverging", merged }))).toBe(merged.content);
    expect(mergedContent(file(), entry({ status: "compatible", merged }))).toBe(merged.content);
  });

  it("reads the one side that did the work otherwise", () => {
    expect(mergedContent(file(), entry({ status: "only_a" }))).toBe("a\n");
    expect(mergedContent(file(), entry({ status: "identical" }))).toBe("a\n");
    expect(mergedContent(file(), entry({ status: "only_b" }))).toBe("b\n");
  });

  it("has nothing to read for binary, windowed, truncated, or missing content", () => {
    const merged = content("m\n");
    expect(mergedContent(file({ binary: true }), entry({ merged }))).toBeNull();
    expect(mergedContent(file(), entry({ status: "diverging" }))).toBeNull();
    expect(
      mergedContent(file(), entry({ merged: content("m\n", { truncated: true }) })),
    ).toBeNull();
    expect(
      mergedContent(
        file({ a: content("a\n", { regions: [{ start: 1, lines: 1 }] }) }),
        entry({ merged }),
      ),
    ).toBeNull();
    expect(
      mergedContent(file({ a: content("", { missing: true }) }), entry({ status: "only_a" })),
    ).toBeNull();
    expect(mergedContent(file(), undefined)).toBeNull();
  });
});

describe("divergenceStatusLabel", () => {
  it("names every status", () => {
    expect(divergenceStatusLabel("identical")).toBe("same result");
    expect(divergenceStatusLabel("diverging")).toBe("diverging");
    expect(divergenceStatusLabel("compatible")).toBe("compatible");
    expect(divergenceStatusLabel("only_a")).toBe("A only");
    expect(divergenceStatusLabel("only_b")).toBe("B only");
    expect(divergenceStatusLabel("binary")).toBe("binary");
  });
});
