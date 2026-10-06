import { describe, expect, it } from "vitest";
import { bothChanged, buildBaseRelativeDiff } from "./base-relative-diff";
import { fileContent, threeWayFile } from "./review-fixtures.test-helpers";

const file = () =>
  threeWayFile({
    file: "a.ts",
    base: "start\nend",
    a: "start\nextra\nshared\nend",
    b: "start\nshared\nend",
  });

describe("base-relative file comparison", () => {
  it("retains shared block moves past the matrix budget", () => {
    const lines = Array.from({ length: 1300 }, (_, index) => `line ${index}`);
    const moved = [...lines.slice(650), ...lines.slice(0, 650)].join("\n");
    const result = buildBaseRelativeDiff(
      threeWayFile({ file: "a.ts", base: lines.join("\n"), a: moved, b: moved }),
    );
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.aligned).toBe(true);
    const changes = result.diff.rows.filter((row) => bothChanged(row, result.diff.aligned));
    expect(changes.filter((row) => row.a?.type === "remove")).toHaveLength(650);
    expect(changes.filter((row) => row.a?.type === "add")).toHaveLength(650);
  });

  it("reports the bounded fallback for dense repetition without claiming shared edits", () => {
    const first = Array.from({ length: 1300 }, () => "first");
    const last = Array.from({ length: 1300 }, () => "last");
    const base = [...first, ...last].join("\n");
    const moved = [...last, ...first].join("\n");
    const result = buildBaseRelativeDiff(threeWayFile({ file: "a.ts", base, a: moved, b: moved }));
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.aligned).toBe(false);
    expect(result.diff.rows.some((row) => bothChanged(row, result.diff.aligned))).toBe(false);
    expect(
      result.diff.rows
        .flatMap((row) => (row.a && row.a.type !== "remove" ? [row.a.content] : []))
        .join("\n"),
    ).toBe(moved);
  });

  it("does not mark equal text inserted at different original positions as Both", () => {
    const result = buildBaseRelativeDiff(
      threeWayFile({
        file: "a.ts",
        base: "first\nsecond\nlast",
        a: "first\nshared\nsecond\nlast",
        b: "first\nsecond\nshared\nlast",
      }),
    );
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.rows.some((row) => bothChanged(row, result.diff.aligned))).toBe(false);
  });

  it("preserves repeated insertion counts and every side's resulting text", () => {
    const input = threeWayFile({
      file: "a.ts",
      base: "first\nlast",
      a: "first\n\nshared\nshared\nlast",
      b: "first\nshared\nlast",
    });
    const result = buildBaseRelativeDiff(input);
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.rows.filter((row) => bothChanged(row, result.diff.aligned))).toHaveLength(1);
    expect(
      result.diff.rows
        .flatMap((row) => (row.a && row.a.type !== "remove" ? [row.a.content] : []))
        .join("\n"),
    ).toBe(input.a?.content);
    expect(
      result.diff.rows
        .flatMap((row) => (row.b && row.b.type !== "remove" ? [row.b.content] : []))
        .join("\n"),
    ).toBe(input.b?.content);
  });

  it("marks matching additions without marking the extra line or unchanged context", () => {
    const result = buildBaseRelativeDiff(file());
    if (result.kind !== "ready") throw new Error(result.message);
    expect(
      result.diff.rows
        .filter((row) => bothChanged(row, result.diff.aligned))
        .map((row) => row.a?.content),
    ).toEqual(["shared"]);
  });

  it("distinguishes an unknown original from a newly added file", () => {
    const input = file();
    delete input.base;
    expect(buildBaseRelativeDiff(input)).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("original was not sent"),
    });
    input.base = { ...fileContent(""), missing: true };
    const result = buildBaseRelativeDiff(input);
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.rows.every((row) => row.base === null)).toBe(true);
  });

  it("shows a deleted file as removals while retaining the other agent's original", () => {
    const input = file();
    input.a = { ...fileContent(""), missing: true };
    input.b = input.base;
    const result = buildBaseRelativeDiff(input);
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.rows.map((row) => [row.a?.type, row.b?.type])).toEqual([
      ["remove", "context"],
      ["remove", "context"],
    ]);
  });

  it("refuses to turn absent agent content into a deletion", () => {
    const input = file();
    delete input.b;
    expect(buildBaseRelativeDiff(input).kind).toBe("unavailable");
  });

  it("preserves window boundaries and source line numbers", () => {
    const input = file();
    const regions = [
      { start: 20, lines: 1 },
      { start: 90, lines: 1 },
    ];
    input.base = { ...fileContent("old\nend"), regions, lines: 100 };
    input.a = { ...fileContent("new\nend"), regions, lines: 100 };
    input.b = input.base;
    const result = buildBaseRelativeDiff(input);
    if (result.kind !== "ready") throw new Error(result.message);
    expect(result.diff.breaks.map((gap) => gap.lines)).toEqual([19, 69, 10]);
    expect(result.diff.rows.find((row) => row.a?.lineNumber === 90)?.a?.content).toBe("end");
    expect(result.diff.rows.some((row) => row.a?.lineNumber === 2)).toBe(false);
  });

  it("does not pair mismatched retained windows or unlocated truncation", () => {
    const input = file();
    input.base = {
      ...fileContent("one\ntwo"),
      regions: [
        { start: 1, lines: 1 },
        { start: 30, lines: 1 },
      ],
      lines: 50,
    };
    input.a = { ...fileContent("one"), regions: [{ start: 1, lines: 1 }], lines: 50 };
    expect(buildBaseRelativeDiff(input).kind).toBe("unavailable");
    input.base = { ...fileContent("one"), truncated: true };
    input.a = fileContent("one");
    expect(buildBaseRelativeDiff(input).kind).toBe("unavailable");
  });

  it("does not treat a nonempty file with no retained windows as an empty file", () => {
    const input = file();
    input.a = { ...fileContent(""), regions: [], lines: 100 };
    expect(buildBaseRelativeDiff(input).kind).toBe("unavailable");
  });
});
