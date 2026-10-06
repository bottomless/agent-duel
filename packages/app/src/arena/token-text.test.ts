import { describe, expect, it } from "vitest";
import { mergeTokenRuns } from "./token-text";

describe("mergeTokenRuns", () => {
  it("cuts at every token and segment boundary", () => {
    const runs = mergeTokenRuns(
      [
        { text: "return", style: "keyword" },
        { text: " ", style: null },
        { text: "42", style: "number" },
      ],
      [
        { text: "return 4", changed: false },
        { text: "2", changed: true },
      ],
    );
    expect(runs.map((run) => [run.text, run.style, run.changed])).toEqual([
      ["return", "keyword", false],
      [" ", null, false],
      ["4", "number", false],
      ["2", "number", true],
    ]);
  });

  it("keeps the tokens alone when the segments spell a different line", () => {
    const runs = mergeTokenRuns([{ text: "a", style: null }], [{ text: "b", changed: true }]);
    expect(runs).toEqual([{ key: "t0", text: "a", style: null, changed: false }]);
  });

  it("returns tokens unchanged without segments", () => {
    expect(mergeTokenRuns([{ text: "x", style: "variable" }], undefined)).toEqual([
      { key: "t0", text: "x", style: "variable", changed: false },
    ]);
  });
});
