import type { DiffLine } from "@/utils/tool-call-parsers";

interface Match {
  base: number;
  other: number;
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Hunt–Szymanski LCS: store only equal-line pairs instead of an N×M matrix.
// Repeated lines can still make that quadratic, so count the pairs before
// allocating the traceback. The same work budget bounds its three int arrays.
export function buildSparseLineDiff(
  base: readonly string[],
  other: readonly string[],
  budget: number,
): DiffLine[] | null {
  const positions = new Map<string, number[]>();
  for (const [index, content] of other.entries()) {
    const found = positions.get(content);
    if (found) found.push(index);
    else positions.set(content, [index]);
  }
  let pairs = 0;
  for (const content of base) {
    pairs += positions.get(content)?.length ?? 0;
    if (pairs > budget) return null;
  }

  const baseAt = new Int32Array(pairs);
  const otherAt = new Int32Array(pairs);
  const previous = new Int32Array(pairs);
  const tails: number[] = [];
  const tailNodes: number[] = [];
  let node = 0;
  for (const [baseIndex, content] of base.entries()) {
    const matches = positions.get(content) ?? [];
    // Descending destinations prevent one base line matching twice.
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const otherIndex = matches[index]!;
      const length = lowerBound(tails, otherIndex);
      if (tails[length] === otherIndex) continue;
      baseAt[node] = baseIndex;
      otherAt[node] = otherIndex;
      previous[node] = length === 0 ? -1 : tailNodes[length - 1]!;
      tails[length] = otherIndex;
      tailNodes[length] = node;
      node += 1;
    }
  }

  const matches: Match[] = [];
  let cursor = tailNodes.at(-1) ?? -1;
  while (cursor !== -1) {
    matches.push({ base: baseAt[cursor]!, other: otherAt[cursor]! });
    cursor = previous[cursor]!;
  }
  matches.reverse();
  return matchedLines(base, other, matches);
}

function matchedLines(
  base: readonly string[],
  other: readonly string[],
  matches: readonly Match[],
): DiffLine[] {
  const lines: DiffLine[] = [];
  let baseIndex = 0;
  let otherIndex = 0;
  // The terminal anchor emits the unmatched tail with the same walk.
  for (const match of [...matches, { base: base.length, other: other.length }]) {
    while (baseIndex < match.base) {
      lines.push({ type: "remove", content: `-${base[baseIndex++]}` });
    }
    while (otherIndex < match.other) {
      lines.push({ type: "add", content: `+${other[otherIndex++]}` });
    }
    if (baseIndex < base.length) {
      lines.push({ type: "context", content: ` ${base[baseIndex++]}` });
      otherIndex += 1;
    }
  }
  return lines;
}
