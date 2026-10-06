import { describe, expect, it } from "vitest";
import { attachCombinedTokens, tokensSpelling } from "./combined-tokens";
import type { CombinedRow } from "./combined-diff";

describe("tokensSpelling", () => {
  it("returns the tokens that spell the line", () => {
    const tokens = [
      { text: "return", style: "keyword" as const },
      { text: " a", style: null },
    ];
    expect(tokensSpelling(tokens, "return a")).toEqual(tokens);
  });

  it("drops tokens that spell another line", () => {
    const tokens = [{ text: "return a", style: null }];
    expect(tokensSpelling(tokens, "return b")).toBeUndefined();
    expect(tokensSpelling(tokens, "return a ")).toBeUndefined();
    expect(tokensSpelling(undefined, "return a")).toBeUndefined();
  });
});

describe("attachCombinedTokens", () => {
  it("colours a row from its own line, never from a wrong line number", () => {
    const aText = "x = 1\ny = 2\nz = 3\n";
    // The row claims line 3 of A but carries line 1's text, as the deleted-run
    // bug once produced; the tokens must spell the row, so they come from the
    // row's own text instead.
    const rows: CombinedRow[] = [
      {
        key: "r0",
        kind: "removed",
        side: "b",
        line: { key: "r0", content: "x = 1", lineA: 3, lineB: null },
      },
    ];
    const [row] = attachCombinedTokens(rows, { aText, bText: "", ext: "py" });
    expect(row?.kind).toBe("removed");
    if (row?.kind !== "removed") return;
    expect(row.line.tokens?.map((token) => token.text).join("")).toBe("x = 1");
  });
});
