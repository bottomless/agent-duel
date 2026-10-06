import { parsePatch, type StructuredPatchHunk } from "diff"
import { parseTree, type ParseError, type Node } from "jsonc-parser"

const BUDGET = 64_000

export interface ComparisonFileFact {
  readonly file: string
  readonly changedA: boolean
  readonly changedB: boolean
  readonly sameResult: boolean
  readonly additionsA: number
  readonly deletionsA: number
  readonly additionsB: number
  readonly deletionsB: number
  readonly binaryA: boolean
  readonly binaryB: boolean
}

interface EvidenceInput {
  readonly aToB: string
  readonly aToBTruncated: boolean
  readonly baseToA: string
  readonly baseToB: string
  readonly baseToATruncated: boolean
  readonly baseToBTruncated: boolean
  readonly files: readonly ComparisonFileFact[]
}

interface FilePatch {
  readonly name: string
  readonly source: string
  readonly metadata: string
  readonly hunks: readonly StructuredPatchHunk[]
  readonly unavailable: boolean
}

// Compare JSON token spelling, not parsed numeric values. This recognizes only
// whitespace changes and preserves large numbers, string contents and array order.
function json(source: string) {
  const errors: ParseError[] = []
  const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false })
  if (!root || errors.length) return undefined
  return {
    source,
    root,
    tokens: source.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, (part) => (part.startsWith('"') ? part : "")),
    length: root.type === "array" ? (root.children?.length ?? 0) : undefined,
  }
}

// Only align explicit, unique scalar ids. Duplicate/missing ids stay positional;
// a numeric token is never converted to a JS number for identity.
function records(node: Node, source: string) {
  if (node.type !== "array") return undefined
  const result = new Map<string, Node>()
  for (const item of node.children ?? []) {
    if (item.type !== "object") return undefined
    const ids = item.children?.filter((property) => property.children?.[0]?.value === "id") ?? []
    const id = ids.length === 1 ? ids[0]?.children?.[1] : undefined
    if (!id || (id.type !== "string" && id.type !== "number")) return undefined
    const key = source.slice(id.offset, id.offset + id.length)
    if (result.has(key)) return undefined
    result.set(key, item)
  }
  return result
}

// Values stay as source tokens: JS numbers would round large integer changes away.
function jsonDifferences(
  a: ReturnType<typeof json>,
  b: ReturnType<typeof json>,
  relation = "A/B",
  leftLabel = "A",
  rightLabel = "B",
) {
  if (!a || !b) return undefined
  if (a.tokens === b.tokens)
    return { text: `${relation}: identical JSON tokens (ignoring whitespace outside strings).`, complete: true }
  const pending: Array<{ a: Node; b: Node; path: string }> = [{ a: a.root, b: b.root, path: "" }]
  const details: string[] = []
  const changedFields = new Map<string, number>()
  let count = 0
  let membershipChanges = 0
  let valuesExcerpted = false
  const changed = (detail: string) => {
    count++
    if (details.length < 6) details.push(detail)
  }
  while (pending.length) {
    const pair = pending.pop()!
    const left = a.source.slice(pair.a.offset, pair.a.offset + pair.a.length)
    const right = b.source.slice(pair.b.offset, pair.b.offset + pair.b.length)
    if (left === right) continue
    const ar = records(pair.a, a.source)
    const br = records(pair.b, b.source)
    if (ar && br) {
      const keysA = [...ar.keys()]
      const keysB = [...br.keys()]
      const sharedA = keysA.filter((id) => br.has(id))
      const sharedB = keysB.filter((id) => ar.has(id))
      if (sharedA.some((id, index) => id !== sharedB[index])) {
        const reversed = sharedA.every((id, index) => id === sharedB[sharedB.length - index - 1])
        changed(
          `Array ${JSON.stringify(pair.path)}: order of matching record ids ${reversed ? "reversed" : "changed"}; values are compared by unique id, not position.`,
        )
      }
      membershipChanges += keysA.filter((id) => !br.has(id)).length + keysB.filter((id) => !ar.has(id)).length
      for (const id of keysA)
        if (!br.has(id))
          changed(
            `Array ${JSON.stringify(pair.path)}: record id ${id} exists in ${leftLabel}, absent from ${rightLabel}.`,
          )
      for (const id of keysB)
        if (!ar.has(id))
          changed(
            `Array ${JSON.stringify(pair.path)}: record id ${id} absent from ${leftLabel}, exists in ${rightLabel}.`,
          )
      for (let index = sharedA.length - 1; index >= 0; index--) {
        const id = sharedA[index]!
        pending.push({ a: ar.get(id)!, b: br.get(id)!, path: `${pair.path}/[id=${id}]` })
      }
      continue
    }
    const ac = pair.a.children ?? []
    const bc = pair.b.children ?? []
    // Pair by position, never guess record identity. A resized array or reordered
    // object is reported as a changed region rather than inventing correspondence.
    const arrays = pair.a.type === "array" && pair.b.type === "array" && ac.length === bc.length
    const keys = ac.map((node) => node.children?.[0]?.value)
    const objects =
      pair.a.type === "object" &&
      pair.b.type === "object" &&
      ac.length === bc.length &&
      new Set(keys).size === keys.length &&
      keys.every((key, index) => key === bc[index]?.children?.[0]?.value)
    if (arrays || objects) {
      for (let index = ac.length - 1; index >= 0; index--) {
        const name = objects ? String(keys[index]).replace(/~/g, "~0").replace(/\//g, "~1") : String(index)
        pending.push({
          a: objects ? ac[index]!.children![1]! : ac[index]!,
          b: objects ? bc[index]!.children![1]! : bc[index]!,
          path: `${pair.path}/${name}`,
        })
      }
      continue
    }
    // Whitespace around container members does not change tokens. Duplicate keys
    // and changed member order deliberately fall back to a whole-region comparison.
    const tokens = (value: string) =>
      value.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, (part) => (part.startsWith('"') ? part : ""))
    if (tokens(left) === tokens(right)) continue
    const field = pair.path.slice(pair.path.lastIndexOf("/") + 1) || "(root)"
    changedFields.set(field, (changedFields.get(field) ?? 0) + 1)
    if (details.length < 6) {
      const view = differenceWindow(left, right, 700)
      valuesExcerpted ||= view.partial
      details.push(
        `Location ${JSON.stringify(pair.path)} ([id=...] selects a unique record id; other array segments are positions):\n${leftLabel}: ${view.a}\n${rightLabel}: ${view.b}${pair.a.type === "string" && pair.b.type === "string" ? `\nString change: ${view.removed === 1 && view.added === 1 ? "one source character replaced, not inserted" : "value replaced"}.` : ""}`,
      )
    }
    count++
  }
  if (!count) return undefined
  const fields = [...changedFields]
    .slice(0, 12)
    .map(([field, changes]) => `${JSON.stringify(field)} (${changes})`)
    .join(", ")
  const text = `${relation} JSON value differences: ${count} changed regions; ${details.length} shown. All other compared values match between ${leftLabel} and ${rightLabel}; records with unique ids are matched by id, not position.\nChanged value-location suffixes across the entire comparison: ${fields || "none (only record membership/order changed)"}${changedFields.size > 12 ? " [more suffixes omitted]" : "; no other value-location suffixes changed"}.\n${details.join("\n")}\n${count > details.length ? "[Additional changed regions omitted]" : "[All changed regions listed; long values may be excerpted]"}`
  const preservation =
    !membershipChanges && !changedFields.size
      ? `\n${relation}: record membership and values preserved; only order differs.`
      : ""
  return { text: text + preservation, complete: count === details.length && !valuesExcerpted }
}

function differenceWindow(a: string, b: string, limit: number) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  const from = Math.max(0, start - 80)
  const view = (value: string) =>
    `${from ? "[same prefix omitted] " : ""}${excerpt(value.slice(from, value.length - Math.max(0, end - 80)), limit)}${end > 80 ? " [same suffix omitted]" : ""}`
  return {
    a: view(a),
    b: view(b),
    removed: a.length - start - end,
    added: b.length - start - end,
    partial: Math.max(a.length, b.length) - Math.max(0, end - 80) - from > limit,
  }
}

function sides(hunk: StructuredPatchHunk) {
  return {
    before: hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1))
      .join("\n"),
    after: hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n"),
  }
}

function wholeJSON(file: FilePatch | undefined) {
  if (!file || file.unavailable || !file.name.endsWith(".json") || file.hunks.length !== 1) return undefined
  const hunk = file.hunks[0]!
  if (hunk.oldStart > 1 || hunk.newStart > 1) return undefined
  const text = sides(hunk)
  const before = json(text.before)
  const after = json(text.after)
  if (!after) return undefined
  return { before, after }
}

function filePatches(patch: string, truncated: boolean) {
  const sources = patch.split(/(?=^diff --git )/m).filter((value) => value.trim())
  return sources.map((source, index): FilePatch => {
    const header = source.split("\n", 1)[0]!
    const hunkStart = source.indexOf("\n@@")
    const metadata = hunkStart < 0 ? source : source.slice(0, hunkStart)
    const headerPath = /^diff --git a\/(.*) b\/\1$/.exec(header)?.[1] ?? header
    const fallback = { name: headerPath, source, metadata: "", hunks: [], unavailable: true }
    // A clipped final line can satisfy line counts. Do not interpret the last
    // file of a capped Git read at all, even when the diff parser accepts it.
    if (truncated && index === sources.length - 1) return fallback
    if (!source.startsWith("diff --git ")) return fallback
    try {
      const parsed = parsePatch(source)
      const patch = parsed[0]
      if (parsed.length !== 1 || !patch) return fallback
      const path = patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName
      const name = path?.replace(/^[ab]\//, "") ?? headerPath
      const binary = source.includes("\nGIT binary patch\n") || source.includes("\nBinary files ")
      return { name, source, metadata, hunks: patch.hunks, unavailable: binary }
    } catch {
      // Malformed/capped hunks cannot provide trustworthy before/after pairs.
      return fallback
    }
  })
}

// Cuts within already-separated old/new text, never within the raw diff. Both
// ends are retained, with an explicit omission marker (also for minified lines).
function excerpt(value: string, limit: number) {
  if (value.length <= limit) return value || "[empty]"
  const take = Math.max(0, Math.floor((limit - 90) / 2))
  return `${value.slice(0, take)}\n[... ${value.length - take * 2} characters omitted; excerpt only ...]\n${value.slice(value.length - take)}`
}

function renderPatch(file: FilePatch | undefined, limit: number, gitTruncated: boolean) {
  if (!file)
    return {
      text: gitTruncated ? "[Evidence unavailable; do not assume unchanged]" : "[Unchanged from base]",
      partial: gitTruncated,
    }
  if (file.unavailable)
    return { text: "[Contents unavailable or binary; no conclusions about missing content]", partial: true }
  if (file.source.length <= limit) return { text: file.source, partial: false }
  const header = `${excerpt(file.metadata, 600)}\n[PARTIAL file evidence]\n`
  if (!file.hunks.length) return { text: `${header}[File metadata exceeds evidence budget]`, partial: true }
  const available = Math.max(0, limit - header.length - 100)
  const count = Math.min(file.hunks.length, Math.max(1, Math.floor(available / 1000)))
  const share = Math.max(180, Math.floor(available / count))
  const parts = Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? 0 : Math.round((index * (file.hunks.length - 1)) / (count - 1))
    const hunk = file.hunks[position]!
    const text = sides(hunk)
    const size = Math.max(90, Math.floor((share - 200) / 2))
    const newline = hunk.lines.some((line) => line.startsWith("\\")) ? "\n[Patch includes a final-newline change]" : ""
    return `Hunk ${position + 1}/${file.hunks.length}; base ${hunk.oldStart}+${hunk.oldLines}, result ${hunk.newStart}+${hunk.newLines}\nBefore:\n${excerpt(text.before, size)}\nAfter:\n${excerpt(text.after, size)}${newline}`
  })
  return {
    text: `${header}${parts.join("\n")}\n[${file.hunks.length - count} additional hunks omitted]`,
    partial: true,
  }
}

function renderDifference(file: FilePatch, limit: number) {
  if (file.unavailable) return { text: "A/B difference contents unavailable.", partial: true }
  const heading = "A/B final-result differences (A is Before, B is After; use base patches for attribution):\n"
  if (file.source.length + heading.length <= limit) return { text: heading + file.source, partial: false }
  const count = Math.min(file.hunks.length, 8)
  const share = Math.floor((limit - heading.length - 200) / Math.max(1, count))
  const parts = file.hunks.slice(0, count).map((hunk) => {
    const text = sides(hunk)
    const view = differenceWindow(text.before, text.after, Math.max(90, Math.floor((share - 160) / 2)))
    return `A line ${hunk.oldStart}, B line ${hunk.newStart}:\nA: ${view.a}\nB: ${view.b}`
  })
  return {
    text: `${heading}${parts.join("\n")}\n[Partial A/B excerpts; ${file.hunks.length - count} additional hunks omitted]`,
    partial: true,
  }
}

interface FilePair {
  readonly name: string
  readonly a: FilePatch | undefined
  readonly b: FilePatch | undefined
  readonly direct?: FilePatch
  readonly fact: ComparisonFileFact | undefined
}

function prepareFile(pair: FilePair) {
  const { a, b, fact } = pair
  const directJSON = wholeJSON(pair.direct)
  const fromA = wholeJSON(a)
  const fromB = wholeJSON(b)
  const base = fromA?.before ?? fromB?.before
  const ja = fromA ?? (directJSON?.before ? { before: base, after: directJSON.before } : undefined)
  const jb = fromB ?? (directJSON?.after ? { before: base, after: directJSON.after } : undefined)
  const sameJSON = ja !== undefined && jb !== undefined && ja.after.tokens === jb.after.tokens
  const identical =
    fact?.sameResult === true ||
    (a !== undefined && b !== undefined && !a.unavailable && !b.unavailable && a.source === b.source)
  const differences = !identical && !sameJSON ? jsonDifferences(ja?.after, jb?.after) : undefined
  const baseA = jsonDifferences(ja?.before, ja?.after, "Base/A", "Base", "A")
  const baseB = jsonDifferences(jb?.before, jb?.after, "Base/B", "Base", "B")
  const notes = [`File: ${JSON.stringify(pair.name)}`]
  if (fact) {
    notes.push(
      `Git facts: A ${fact.changedA ? "changed" : "unchanged"}; B ${fact.changedB ? "changed" : "unchanged"}. Binary: ${fact.binaryA || fact.binaryB}.`,
    )
  }
  if (identical)
    notes.push("Git: A and B have identical file results. This does not prove correctness against the task.")
  else if (sameJSON)
    notes.push(
      "A and B have identical JSON tokens; only whitespace outside strings differs. This does not prove correctness against the task.",
    )
  else if (fact?.sameResult === false)
    notes.push("Git: A and B have DIFFERENT file results; matching excerpts do not imply equality.")
  for (const [side, parsed] of [
    ["A", ja],
    ["B", jb],
  ] as const) {
    if (parsed?.before?.length !== undefined && parsed.after.length !== undefined) {
      notes.push(
        `${side} JSON array lengths: base ${parsed.before.length}, result ${parsed.after.length}. Counts alone do not prove preservation of values.`,
      )
    }
  }
  // JSON equivalence concerns contents only: retain both metadata headers for
  // file modes and other non-content changes even when content is shared.
  if (ja && jb) {
    notes.push(`A metadata: ${a?.metadata ?? "[no base patch]"}\nB metadata: ${b?.metadata ?? "[no base patch]"}`)
  }
  return {
    ...pair,
    notes: notes.join("\n"),
    differences: differences?.text,
    baseA: baseA?.text,
    baseB: baseB?.text,
    jsonComplete: !!baseA?.complete && !!baseB?.complete && (identical || sameJSON || !!differences?.complete),
    shared: (identical || sameJSON) && a !== undefined && b !== undefined && !a.unavailable && !b.unavailable,
  }
}

export function prepareEvidence(input: EvidenceInput) {
  const a = filePatches(input.baseToA, input.baseToATruncated)
  const b = filePatches(input.baseToB, input.baseToBTruncated)
  const direct = filePatches(input.aToB, input.aToBTruncated)
  const byDirect = new Map(direct.map((file) => [file.name, file]))
  const byA = new Map(a.map((file) => [file.name, file]))
  const byB = new Map(b.map((file) => [file.name, file]))
  const facts = new Map(input.files.map((file) => [file.file, file]))
  const names = [...new Set([...facts.keys(), ...byA.keys(), ...byB.keys(), ...byDirect.keys()])].sort()
  const files = names.map((name) =>
    prepareFile({ name, a: byA.get(name), b: byB.get(name), fact: facts.get(name), direct: byDirect.get(name) }),
  )
  // Keep complete small patches grouped by agent. A third direction and a shared
  // section can reverse attribution even when the file facts are correct.
  const full = [
    ...files.map((file) => [file.notes, file.differences].filter(Boolean).join("\n")),
    "## Git diff (base -> A)",
    input.baseToA || "[A left the base tree unchanged]",
    "## Git diff (base -> B)",
    input.baseToB || "[B left the base tree unchanged]",
  ].join("\n")
  const cappedGit = input.baseToATruncated || input.baseToBTruncated || input.aToBTruncated
  if (!cappedGit && full.length <= BUDGET && !files.some((file) => file.a?.unavailable || file.b?.unavailable))
    return { text: full, partial: false }

  // Share the budget across files first; short files donate unused space. A
  // single generated file cannot crowd out a later source file or B-only edit.
  const selected = files.slice(0, 80)
  const header = `Evidence inventory: ${files.length} changed files; ${files.length - selected.length} files omitted from this request.\nAll excerpts are relative to the shared base. Missing excerpts are unknown, not deletions.\n`
  let partial = cappedGit || selected.length < files.length
  let remaining = BUDGET - header.length
  const pieces: string[] = []
  for (let index = 0; index < selected.length; index++) {
    const file = selected[index]!
    const budget = Math.floor(remaining / (selected.length - index))
    const notes = excerpt(file.notes, Math.min(8000, Math.floor(budget / 3)))
    // Complete JSON can be compared before budgeting. Send changed positions,
    // not clipped arrays that can be mistaken for the entire result. Base
    // comparisons remain necessary when both contestants make the same mistake.
    if (
      file.baseA &&
      (file.shared || file.baseB) &&
      (file.a?.source.length ?? 0) + (file.b?.source.length ?? 0) > budget - notes.length
    ) {
      const sections = [file.differences, file.baseA, file.baseB].filter((value): value is string => !!value)
      const share = Math.floor((budget - notes.length - 250) / Math.max(1, sections.length))
      const body = sections.map((section) => excerpt(section, Math.max(90, share))).join("\n")
      const part = `${notes}\nComputed JSON comparisons against the base; facts apply to this file only. Preservation is verified only where explicitly stated.\n${body}\n\n`
      const safe =
        part.length <= budget
          ? part
          : `File: ${excerpt(JSON.stringify(file.name), 200)}\n[Content omitted: evidence budget]\n`
      pieces.push(safe)
      remaining -= safe.length
      // Summarizing fully compared contents is not missing evidence. Omitted
      // changes, value excerpts, metadata or budget clipping still are.
      partial ||=
        !file.jsonComplete ||
        notes !== file.notes ||
        safe !== part ||
        sections.some((section) => section.length > Math.max(90, share))
      continue
    }
    const directBudget =
      file.direct && !file.shared && !file.differences ? Math.floor((budget - notes.length - 200) / 3) : 0
    const renderedDirect = file.differences
      ? {
          text: excerpt(file.differences, Math.max(180, Math.floor((budget - notes.length - 200) / 3))),
          partial: file.differences.length > Math.max(180, Math.floor((budget - notes.length - 200) / 3)),
        }
      : directBudget > 300
        ? renderDifference(file.direct!, directBudget)
        : undefined
    const bodyBudget = budget - notes.length - (renderedDirect?.text.length ?? 0) - 200
    const aSize = file.a?.source.length ?? 0
    const bSize = file.b?.source.length ?? 0
    const half = Math.floor(bodyBudget / 2)
    const limitA = bSize < half ? bodyBudget - bSize : half
    const limitB = aSize < half ? bodyBudget - aSize : half
    const renderedA = renderPatch(
      file.a,
      file.shared ? bodyBudget : limitA,
      input.baseToATruncated || (file.fact?.changedA === true && !file.a),
    )
    const renderedB = file.shared
      ? renderedA
      : renderPatch(file.b, limitB, input.baseToBTruncated || (file.fact?.changedB === true && !file.b))
    const content = file.shared
      ? `Shared base-to-result content for A and B:\n${renderedA.text}`
      : `Agent A:\n${renderedA.text}\nAgent B:\n${renderedB.text}`
    partial ||= renderedA.partial || renderedB.partial || !!renderedDirect?.partial || notes !== file.notes
    const part = `${notes}\n${renderedDirect ? renderedDirect.text + "\n" : ""}${content}\n\n`
    // Never fall back to raw prefix slicing. If overhead exhausts this file's
    // allocation, keep its identity and mark its entire content unavailable.
    const safe =
      part.length <= budget
        ? part
        : `File: ${excerpt(JSON.stringify(file.name), 200)}\n[Content omitted: evidence budget]\n`
    partial ||= safe !== part
    pieces.push(safe)
    remaining -= safe.length
  }
  const text = header + pieces.join("")
  return { text, partial }
}
