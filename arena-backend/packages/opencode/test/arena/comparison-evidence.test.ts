import { describe, expect, test } from "bun:test"
import { prepareEvidence } from "../../src/arena/comparison-evidence"

function patch(file: string, before: string, after: string) {
  const old = before.split("\n")
  const next = after.split("\n")
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${old.length} +1,${next.length} @@\n${old.map((line) => `-${line}`).join("\n")}\n${next.map((line) => `+${line}`).join("\n")}\n`
}

function prepare(a: string, b: string) {
  return prepareEvidence({
    aToB: "",
    aToBTruncated: false,
    baseToA: a,
    baseToB: b,
    baseToATruncated: false,
    baseToBTruncated: false,
    files: [],
  })
}

describe("single-request comparison evidence", () => {
  test("recognizes formatting-only JSON results without losing either side of a huge rewrite", () => {
    const rows = Array.from({ length: 12_000 }, (_, id) => ({ id, name: `item-${id}`, payload: "x".repeat(200) }))
    const original = JSON.stringify(rows, null, 2)
    const result = rows.toReversed().map((row) => ({ ...row, name: `done-${row.name}` }))
    const evidence = prepare(
      patch("data.json", original, JSON.stringify(result)),
      patch("data.json", original, JSON.stringify(result, null, 2)),
    )
    expect(evidence.text.length).toBeLessThanOrEqual(64_000)
    expect(evidence.text).toContain("A and B have identical JSON tokens; only whitespace outside strings differs")
    expect(evidence.text).toContain("JSON array lengths: base 12000, result 12000")
    expect(evidence.text).toContain("Base:")
    expect(evidence.text).toContain("A:")
    expect(evidence.text).toContain("done-item-")
    expect(evidence.partial).toBe(true)
  })
})

test("reports a real missing record instead of treating it as formatting", () => {
  const rows = Array.from({ length: 140 }, (_, id) => ({ id, value: "x".repeat(400) }))
  const base = JSON.stringify(rows, null, 2)
  const evidence = prepare(
    patch("data.json", base, JSON.stringify(rows.toReversed())),
    patch("data.json", base, JSON.stringify(rows.toReversed().slice(1), null, 2)),
  )
  expect(evidence.text).toContain("A JSON array lengths: base 140, result 140")
  expect(evidence.text).toContain("B JSON array lengths: base 140, result 139")
  expect(evidence.text).not.toContain("identical JSON tokens")
  expect(evidence.text).toContain("record id 139 exists in A, absent from B")
})

test("does not normalize away number precision, strings or array ordering", () => {
  for (const [a, b] of [
    ["[9007199254740992]", "[9007199254740993]"],
    ['["a b"]', '["ab"]'],
    ["[1,2]", "[2,1]"],
    ['{"x":1,"x":2}', '{"x":2}'],
  ]) {
    const evidence = prepare(patch("data.json", "[]", a), patch("data.json", "[]", b))
    expect(evidence.text).not.toContain("identical JSON tokens")
    expect(evidence.text).toContain(a)
    expect(evidence.text).toContain(b)
  }
})

test("includes a later source file and B-only changes beside a giant shared generated file", () => {
  const huge = patch("a-generated.txt", "old".repeat(100_000), "new".repeat(100_000))
  const a = huge + patch("z-source.ts", "await save()", "save()")
  const b = huge + patch("z-test.ts", "empty", "expect(saved).toBe(true)")
  const evidence = prepare(a, b)
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
  expect(evidence.text).toContain("-await save()")
  expect(evidence.text).toContain("+save()")
  expect(evidence.text).toContain("expect(saved).toBe(true)")
  expect(evidence.text.match(/Shared base-to-result content/g)).toHaveLength(1)
})

test("does not treat clipped Git evidence as deletion or an unchanged side", () => {
  const full = patch("data.json", "[1,2,3]", "[3,2,1]")
  const evidence = prepareEvidence({
    aToB: "",
    aToBTruncated: false,
    baseToA: full.slice(0, full.indexOf("+[3")),
    baseToB: full,
    baseToATruncated: true,
    baseToBTruncated: false,
    files: [],
  })
  expect(evidence.partial).toBe(true)
  expect(evidence.text).toContain("unavailable")
  expect(evidence.text).not.toContain("identical JSON tokens")
  expect(evidence.text).not.toContain("-[1,2,3]\nAgent B")
})

test("keeps identical small changes in both base views without marking them partial", () => {
  const change = patch("same.ts", "old", "new")
  const evidence = prepare(change, change)
  expect(evidence.partial).toBe(false)
  expect(evidence.text.match(/\+new/g)).toHaveLength(2)
  expect(evidence.text).toContain("identical file results")
})

test("bounds file inventories and signals omitted files", () => {
  const change = Array.from({ length: 120 }, (_, id) =>
    patch(`file-${id}.txt`, "old".repeat(1000), "new".repeat(1000)),
  ).join("")
  const evidence = prepare(change, change)
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
  expect(evidence.partial).toBe(true)
  expect(evidence.text).toContain("120 changed files; 40 files omitted")
})

test("keeps mode-only changes and binary identities without sending binary data", () => {
  const mode = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n"
  const binary =
    "diff --git a/logo.png b/logo.png\nindex 123..456 100644\nGIT binary patch\nliteral 2\nsecret-base85-data\n"
  const evidence = prepare(mode + binary, "")
  expect(evidence.text).toContain('File: "run.sh"')
  expect(evidence.text).toContain("new mode 100755")
  expect(evidence.text).toContain('File: "logo.png"')
  expect(evidence.text).not.toContain("secret-base85-data")
  expect(evidence.partial).toBe(true)
})

test("merges clipped-file identity with the complete Git inventory", () => {
  const full = patch("data.json", "[1,2,3]", "[3,2,1]")
  const evidence = prepareEvidence({
    aToB: "",
    aToBTruncated: false,
    baseToA: full.slice(0, -4),
    baseToB: full,
    baseToATruncated: true,
    baseToBTruncated: false,
    files: [
      {
        file: "data.json",
        changedA: true,
        changedB: true,
        sameResult: true,
        additionsA: 1,
        deletionsA: 1,
        additionsB: 1,
        deletionsB: 1,
        binaryA: false,
        binaryB: false,
      },
    ],
  })
  expect(evidence.text).toContain("1 changed files")
  expect(evidence.text).toContain("identical file results")
  expect(evidence.text).toContain("unavailable")
  expect(evidence.text).not.toContain("Shared base-to-result")
})

test("finds a changed JSON value in the middle of a minified result", () => {
  const rows = Array.from({ length: 140 }, (_, id) => ({ id, payload: "x".repeat(400) }))
  const a = JSON.stringify(rows.toReversed())
  const b = JSON.stringify(rows.toReversed().map((row) => (row.id === 70 ? { ...row, payload: "CORRUPTED" } : row)))
  const evidence = prepare(patch("data.json", JSON.stringify(rows), a), patch("data.json", JSON.stringify(rows), b))
  expect(evidence.text).toContain("A/B JSON value differences: 1")
  expect(evidence.text).toContain("/[id=70]/payload")
  expect(evidence.text).toContain("CORRUPTED")
  expect(evidence.text).toContain("All other compared values match between A and B")
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
})

test("uses the direct Git difference to locate a middle change in a long non-JSON line", () => {
  const prefix = "unchanged ".repeat(10000)
  const suffix = " unchanged".repeat(10000)
  const a = prefix + "await save()" + suffix
  const b = prefix + "save()" + suffix
  const evidence = prepareEvidence({
    baseToA: patch("bundle.js", "old", a),
    baseToB: patch("bundle.js", "old", b),
    aToB: patch("bundle.js", a, b),
    aToBTruncated: false,
    baseToATruncated: false,
    baseToBTruncated: false,
    files: [],
  })
  expect(evidence.text).toContain("await save()")
  expect(evidence.text).toContain("A/B final-result differences")
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
  expect(evidence.partial).toBe(true)
})

test("does not read a clipped direct patch as a complete JSON difference", () => {
  const direct = patch("data.json", "[1,2,3]", "[3,2,1]")
  const evidence = prepareEvidence({
    baseToA: "",
    baseToB: "",
    baseToATruncated: true,
    baseToBTruncated: true,
    aToB: direct.slice(0, -5),
    aToBTruncated: true,
    files: [],
  })
  expect(evidence.partial).toBe(true)
  expect(evidence.text).not.toContain("All other compared values match")
})

test("bounds multiple JSON differences without claiming they were all shown", () => {
  const a = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, value: "a".repeat(800) })))
  const b = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, value: "b".repeat(800) })))
  const evidence = prepare(patch("data.json", "[]", a), patch("data.json", "[]", b))
  expect(evidence.text).toContain("100 changed regions; 6 shown")
  expect(evidence.text).toContain("omitted")
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
  expect(evidence.partial).toBe(true)
})

test("keeps exact numeric tokens, escaped JSON pointers, and duplicate-key differences", () => {
  const a = '{"a/b~c":9007199254740992,"dup":{"x":1,"x":2}}'
  const b = '{"a/b~c":9007199254740993,"dup":{"x":2}}'
  const evidence = prepare(patch("data.json", "{}", a), patch("data.json", "{}", b))
  expect(evidence.text).toContain("/a~1b~0c")
  expect(evidence.text).toContain("9007199254740992")
  expect(evidence.text).toContain("9007199254740993")
  expect(evidence.text).toContain("2 changed regions")
})

test("finds a shared middle corruption against the original despite A/B equality", () => {
  const rows = Array.from({ length: 140 }, (_, id) => ({ id, payload: "x".repeat(400) }))
  const before = JSON.stringify({ version: 1, rows })
  const after = JSON.stringify({
    version: 2,
    rows: rows.map((row) => (row.id === 70 ? { ...row, payload: "BROKEN" } : row)),
  })
  const evidence = prepare(patch("data.json", before, after), patch("data.json", before, after))
  expect(evidence.text).toContain("Base/B JSON value differences: 2")
  expect(evidence.text).toContain("/rows/[id=70]/payload")
  expect(evidence.text).toContain("BROKEN")
  expect(evidence.text).toContain("Base/A JSON value differences: 2")
})

test("does not align duplicate ids or round large numeric ids", () => {
  const duplicate = prepare(
    patch("data.json", "[]", '[{"id":1,"x":0},{"id":1,"x":1}]'),
    patch("data.json", "[]", '[{"id":1,"x":2},{"id":1,"x":1}]'),
  )
  expect(duplicate.text).toContain('Location \"/0/x\"')
  expect(duplicate.text).not.toContain('Location \"/[id=1]')
  const large = prepare(
    patch("data.json", "[]", '[{"id":9007199254740992}]'),
    patch("data.json", "[]", '[{"id":9007199254740993}]'),
  )
  expect(large.text).toContain("record id 9007199254740992 exists in A, absent from B")
  expect(large.text).toContain("record id 9007199254740993 absent from A, exists in B")
})

test("keeps small shared work in both agents' base views without a misleading reverse diff", () => {
  const common = patch("balance.ts", "export const display = x => x;", "export const display = x => Math.max(0, x);")
  const logA = patch("log.ts", "export const log = x => {};", "export const log = x => console.log(x);")
  const docsB = patch("README.md", "# Balance", "# Balance\nNegative balances display as zero.")
  const evidence = prepareEvidence({
    baseToA: common + logA,
    baseToB: common + docsB,
    aToB: patch("log.ts", "export const log = x => console.log(x);", "export const log = x => {};") + docsB,
    baseToATruncated: false,
    baseToBTruncated: false,
    aToBTruncated: false,
    files: [],
  })
  expect(evidence.partial).toBe(false)
  expect(evidence.text).toContain(`## Git diff (base -> A)\n${common}${logA}`)
  expect(evidence.text).toContain(`## Git diff (base -> B)\n${common}${docsB}`)
  expect(evidence.text).not.toContain("A/B final-result differences")
  expect(evidence.text).not.toContain("-export const log = x => console.log(x);")
})

test("complete JSON summaries verify preservation separately from a missing record", () => {
  const rows = Array.from({ length: 180 }, (_, id) => ({ id, payload: "z".repeat(480) }))
  const base = JSON.stringify(rows)
  const evidence = prepare(
    patch("data.json", base, JSON.stringify(rows.toReversed())),
    patch(
      "data.json",
      base,
      JSON.stringify(
        rows.toReversed().filter((row) => row.id !== 73),
        null,
        2,
      ),
    ),
  )
  expect(evidence.partial).toBe(false)
  expect(evidence.text).toContain("Base/A: record membership and values preserved; only order differs.")
  expect(evidence.text).toContain("record id 73 exists in Base, absent from B")
  expect(evidence.text).not.toContain("Base/B: record membership and values preserved")
  expect(evidence.text).not.toContain("No global preservation conclusion")
  expect(evidence.text.length).toBeLessThanOrEqual(64_000)
})

test("complete JSON summaries expose a changed value without claiming preservation", () => {
  const rows = Array.from({ length: 180 }, (_, id) => ({ id, enabled: true, payload: "z".repeat(480) }))
  const base = JSON.stringify(rows)
  const a = rows.toReversed().map((row) => (row.id === 91 ? { ...row, enabled: false } : row))
  const evidence = prepare(
    patch("data.json", base, JSON.stringify(a)),
    patch("data.json", base, JSON.stringify(rows.toReversed(), null, 2)),
  )
  expect(evidence.partial).toBe(false)
  expect(evidence.text).toContain("/[id=91]/enabled")
  expect(evidence.text).not.toContain("Base/A: record membership and values preserved")
  expect(evidence.text).toContain("Base/B: record membership and values preserved; only order differs.")
})

test("JSON summaries still disclose omitted value details", () => {
  const base = JSON.stringify({ value: "x".repeat(90_000) })
  const evidence = prepare(
    patch("data.json", base, JSON.stringify({ value: "a".repeat(90_000) })),
    patch("data.json", base, JSON.stringify({ value: "b".repeat(90_000) })),
  )
  expect(evidence.partial).toBe(true)
  expect(evidence.text).toContain("excerpt only")
  expect(evidence.text).not.toContain("record membership and values preserved")
})
