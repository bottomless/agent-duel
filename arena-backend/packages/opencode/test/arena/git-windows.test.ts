import { describe, expect, test } from "bun:test"
import { countLines, parseHunks, planWindows, retainWindows, windowFile } from "../../src/arena/git"

function content(text: string) {
  return { content: text, truncated: false, missing: false }
}

function numbered(count: number, mark?: { line: number; text: string }) {
  return (
    Array.from({ length: count }, (_, index) =>
      mark && mark.line === index + 1 ? mark.text : `line ${index + 1}`,
    ).join("\n") + "\n"
  )
}

describe("parseHunks", () => {
  test("reads both coordinate systems, including pure inserts and deletes", () => {
    const hunks = parseHunks(
      ["diff --git a/f b/f", "@@ -26479,7 +26479,9 @@", "@@ -100,0 +103,4 @@", "@@ -200,3 +0,0 @@"].join("\n"),
    )
    expect(hunks).toEqual([
      { baseStart: 26479, baseCount: 7, sideStart: 26479, sideCount: 9 },
      { baseStart: 100, baseCount: 0, sideStart: 103, sideCount: 4 },
      { baseStart: 200, baseCount: 3, sideStart: 0, sideCount: 0 },
    ])
  })

  test("ignores content lines that look like headers", () => {
    expect(parseHunks(["@@ -1,1 +1,1 @@", "-@@ not a header", "+text"].join("\n"))).toHaveLength(1)
  })
})

describe("countLines", () => {
  test("numbers lines the way git does", () => {
    expect(countLines("")).toBe(0)
    expect(countLines("a\n")).toBe(1)
    expect(countLines("a\nb\n")).toBe(2)
    expect(countLines("a\nb")).toBe(2)
  })
})

describe("planWindows", () => {
  test("keeps the changed run in context and nothing else", () => {
    const plan = planWindows({
      hunksA: [{ baseStart: 500, baseCount: 1, sideStart: 500, sideCount: 3 }],
      hunksB: [],
      baseLines: 1000,
      aLines: 1002,
      bLines: 1000,
      context: 3,
    })
    // Base line 500 alone, three lines of context either side. A's window stretches two
    // lines further because A turned that one line into three.
    expect(plan.base).toEqual([{ start: 497, end: 503 }])
    expect(plan.a).toEqual([{ start: 497, end: 505 }])
    expect(plan.b).toEqual([{ start: 497, end: 503 }])
  })

  test("carries a later window through the line shift an earlier edit caused", () => {
    // A inserts five lines at 100, so everything after it sits five lines lower in A than
    // in base. A window planned in base coordinates has to follow.
    const plan = planWindows({
      hunksA: [
        { baseStart: 100, baseCount: 0, sideStart: 101, sideCount: 5 },
        { baseStart: 900, baseCount: 1, sideStart: 905, sideCount: 1 },
      ],
      hunksB: [],
      baseLines: 1000,
      aLines: 1005,
      bLines: 1000,
      context: 2,
    })
    expect(plan.base).toEqual([
      { start: 98, end: 102 },
      { start: 898, end: 902 },
    ])
    expect(plan.a[1]).toEqual({ start: 903, end: 907 })
  })

  test("folds windows that would overlap once mapped", () => {
    const plan = planWindows({
      hunksA: [
        { baseStart: 100, baseCount: 20, sideStart: 100, sideCount: 1 },
        { baseStart: 130, baseCount: 1, sideStart: 111, sideCount: 1 },
      ],
      hunksB: [],
      baseLines: 400,
      aLines: 381,
      bLines: 400,
      context: 5,
    })
    for (let index = 1; index < plan.a.length; index += 1) {
      expect(plan.a[index]!.start).toBeGreaterThan(plan.a[index - 1]!.end + 1)
    }
  })

  test("plans nothing when neither side reports a hunk", () => {
    expect(planWindows({ hunksA: [], hunksB: [], baseLines: 10, aLines: 10, bLines: 10 }).base).toEqual([])
  })
})

describe("retainWindows", () => {
  test("reports where each retained run starts in the file", () => {
    const retained = retainWindows(numbered(20), [
      { start: 3, end: 5 },
      { start: 15, end: 16 },
    ])
    expect(retained.content).toBe("line 3\nline 4\nline 5\nline 15\nline 16")
    expect(retained.regions).toEqual([
      { start: 3, lines: 3 },
      { start: 15, lines: 2 },
    ])
  })
})

describe("windowFile", () => {
  // The lockfile shape: one small edit far past any byte prefix of the file.
  test("keeps a change that sits beyond the wire budget", () => {
    const base = numbered(3000)
    const a = numbered(3000, { line: 2600, text: "line 2600 CHANGED" })
    const windowed = windowFile({
      base: content(base),
      a: content(a),
      b: content(base),
      hunksA: [{ baseStart: 2600, baseCount: 1, sideStart: 2600, sideCount: 1 }],
      hunksB: [],
      budget: 4_000,
      context: 4,
    })

    expect(windowed.a.content).toContain("line 2600 CHANGED")
    expect(windowed.base.content).toContain("line 2600")
    expect(windowed.a.regions).toEqual([{ start: 2596, lines: 9 }])
    expect(windowed.base.regions).toEqual([{ start: 2596, lines: 9 }])
    expect(windowed.b.regions).toEqual([{ start: 2596, lines: 9 }])
    expect(windowed.a.truncated).toBe(false)
    // The whole file's length rides along, so the viewer can say what sits after the
    // window as well as what sits before it.
    expect(windowed.base.lines).toBe(3000)
    expect(windowed.a.lines).toBe(3000)
    // The whole point: a byte prefix of this file contains none of the change.
    expect(base.slice(0, 4_000)).not.toContain("line 2600")
  })

  test("gives every side the same windows so the columns cannot drift apart", () => {
    const base = numbered(2000)
    const a = numbered(2000, { line: 40, text: "line 40 FROM A" })
    const b = numbered(2000, { line: 1500, text: "line 1500 FROM B" })
    const windowed = windowFile({
      base: content(base),
      a: content(a),
      b: content(b),
      hunksA: [{ baseStart: 40, baseCount: 1, sideStart: 40, sideCount: 1 }],
      hunksB: [{ baseStart: 1500, baseCount: 1, sideStart: 1500, sideCount: 1 }],
      budget: 4_000,
      context: 3,
    })

    expect(windowed.base.regions).toHaveLength(2)
    expect(windowed.a.regions).toHaveLength(2)
    expect(windowed.b.regions).toHaveLength(2)
    expect(windowed.a.content).toContain("line 40 FROM A")
    expect(windowed.b.content).toContain("line 1500 FROM B")
  })

  test("drops whole windows from the tail, from every side at once, when the budget runs out", () => {
    const base = numbered(4000)
    const marks = [200, 1200, 2200, 3200]
    const a = marks.reduce((text, line) => text.replace(`line ${line}\n`, `line ${line} EDITED\n`), base)
    const windowed = windowFile({
      base: content(base),
      a: content(a),
      b: content(base),
      hunksA: marks.map((line) => ({ baseStart: line, baseCount: 1, sideStart: line, sideCount: 1 })),
      hunksB: [],
      budget: 200,
      context: 4,
    })

    const counts = [windowed.base.regions?.length, windowed.a.regions?.length, windowed.b.regions?.length]
    expect(new Set(counts).size).toBe(1)
    expect(counts[0]).toBeLessThan(marks.length)
    expect(counts[0]).toBeGreaterThan(0)
    expect(windowed.base.truncated).toBe(true)
    expect(windowed.a.truncated).toBe(true)
    expect(windowed.b.truncated).toBe(true)
    // What survives is the front of the file, whole windows only -- never half a line.
    expect(windowed.a.content).toContain("line 200 EDITED")
    expect(windowed.a.content.endsWith("\n")).toBe(false)
  })

  test("shrinks a single oversized window in base coordinates, keeping the sides in step", () => {
    // A rewrote the whole file: one window covering everything, too big for the budget.
    const base = numbered(2000)
    const a = numbered(2000).replaceAll("line ", "rewritten ")
    const windowed = windowFile({
      base: content(base),
      a: content(a),
      b: content(base),
      hunksA: [{ baseStart: 1, baseCount: 2000, sideStart: 1, sideCount: 2000 }],
      hunksB: [],
      budget: 2_000,
      context: 2,
    })

    expect(windowed.base.truncated).toBe(true)
    expect(windowed.base.content.length).toBeLessThanOrEqual(2_000)
    expect(windowed.a.content.length).toBeLessThanOrEqual(2_000)
    // Same base range on every side, so the cut lands at one point in the file rather than
    // at three different byte counts.
    expect(windowed.base.regions?.[0]?.lines).toBe(windowed.a.regions?.[0]?.lines)
    expect(windowed.base.regions?.[0]?.lines).toBe(windowed.b.regions?.[0]?.lines)
  })

  test("leaves a side that does not have the file marked missing", () => {
    const base = numbered(3000)
    const windowed = windowFile({
      base: content(base),
      a: content(numbered(3000, { line: 2000, text: "line 2000 EDITED" })),
      b: { content: "", truncated: false, missing: true },
      hunksA: [{ baseStart: 2000, baseCount: 1, sideStart: 2000, sideCount: 1 }],
      hunksB: [{ baseStart: 1, baseCount: 3000, sideStart: 0, sideCount: 0 }],
      budget: 4_000,
      context: 3,
    })
    expect(windowed.b.missing).toBe(true)
    expect(windowed.b.regions).toBeUndefined()
    expect(windowed.a.content).toContain("line 2000 EDITED")
  })

  test("passes a file through untouched when it fits", () => {
    const base = numbered(50)
    const windowed = windowFile({
      base: content(base),
      a: content(base),
      b: content(base),
      hunksA: [],
      hunksB: [],
      budget: 10_000,
    })
    expect(windowed.base.content).toBe(base)
    expect(windowed.base.regions).toBeUndefined()
  })

  test("keeps the head, on a line boundary, when there is nothing to window against", () => {
    const base = numbered(50)
    const windowed = windowFile({
      base: content(base),
      a: content(base),
      b: content(base),
      hunksA: [],
      hunksB: [],
      budget: 40,
    })
    expect(windowed.base.truncated).toBe(true)
    expect(windowed.base.content.length).toBeLessThanOrEqual(40)
    expect(windowed.base.content.split("\n").at(-1)).toMatch(/^line \d+$/)
    expect(windowed.base.regions?.[0]?.start).toBe(1)
  })

  test("keeps the head of a file neither side had before, cut on a line boundary", () => {
    const added = numbered(2000)
    const windowed = windowFile({
      base: { content: "", truncated: false, missing: true },
      a: content(added),
      b: content(added),
      hunksA: [{ baseStart: 0, baseCount: 0, sideStart: 1, sideCount: 2000 }],
      hunksB: [{ baseStart: 0, baseCount: 0, sideStart: 1, sideCount: 2000 }],
      budget: 500,
    })
    expect(windowed.base.missing).toBe(true)
    expect(windowed.a.truncated).toBe(true)
    expect(windowed.a.content.length).toBeLessThanOrEqual(500)
    expect(windowed.a.content.split("\n").at(-1)).toMatch(/^line \d+$/)
    expect(windowed.a.regions).toEqual([{ start: 1, lines: windowed.a.content.split("\n").length }])
    expect(windowed.a.lines).toBe(2000)
    expect(windowed.a.content).toBe(windowed.b.content)
  })
})
