import { describe, expect, it } from "vitest";
import type { ThreeWayCell, ThreeWayRow } from "./three-way-diff";
import { unifiedSideRows } from "./side-rows";

const cell = (
  type: ThreeWayCell["type"],
  lineNumber: number | null,
  content = "",
): ThreeWayCell => ({
  type,
  content,
  lineNumber,
});

function row(
  key: string,
  base: number | null,
  a: ThreeWayCell | null,
  b: ThreeWayCell | null = null,
): ThreeWayRow {
  return { key, base: base === null ? null : { lineNumber: base, content: "" }, a, b };
}

describe("unifiedSideRows", () => {
  it("puts a removed line before the agent's added lines between two unchanged ones", () => {
    // The order the three-way alignment produced for the cart.js battle: A's line 12 is
    // unchanged, but the base line 10 it replaced sat after it to line up with B.
    const rows = [
      row("ctx-8", 8, cell("context", 8)),
      row("add-9", null, cell("add", 9)),
      row("ctx-12", 9, cell("context", 12)),
      row("rm-10", 10, cell("remove", null)),
      row("add-13", null, cell("add", 13)),
      row("ctx-14", 11, cell("context", 20)),
    ];
    expect(unifiedSideRows(rows, "a").map((entry) => entry.key)).toEqual([
      "ctx-8",
      "add-9",
      "ctx-12",
      "rm-10",
      "add-13",
      "ctx-14",
    ]);
  });

  it("orders removals by the original and additions by the agent within one change", () => {
    const rows = [
      row("add-3", null, cell("add", 3)),
      row("rm-2", 2, cell("remove", null)),
      row("add-2", null, cell("add", 2)),
      row("rm-1", 1, cell("remove", null)),
    ];
    expect(unifiedSideRows(rows, "a").map((entry) => entry.key)).toEqual([
      "rm-1",
      "rm-2",
      "add-2",
      "add-3",
    ]);
  });

  it("leaves out rows only the other agent has", () => {
    const rows = [
      row("ctx-1", 1, cell("context", 1), cell("context", 1)),
      row("b-only", null, null, cell("add", 2)),
    ];
    expect(unifiedSideRows(rows, "a").map((entry) => entry.key)).toEqual(["ctx-1"]);
    expect(unifiedSideRows(rows, "b").map((entry) => entry.key)).toEqual(["ctx-1", "b-only"]);
  });
});
