import type { ThreeWayRow } from "./three-way-diff";

/**
 * One agent's rows in unified-diff order. The three-way rows are ordered to line A up with B, so
 * read for one agent alone a removed line can land after that agent's later lines. Unchanged
 * lines are in order on both the original's side and the agent's, so between two of them this
 * puts the removed lines first, in the original's order, then the added ones, in the agent's.
 * Rows the agent has no cell in are dropped.
 */
export function unifiedSideRows(rows: readonly ThreeWayRow[], side: "a" | "b"): ThreeWayRow[] {
  const result: ThreeWayRow[] = [];
  let removed: ThreeWayRow[] = [];
  let added: ThreeWayRow[] = [];
  const flush = () => {
    removed.sort((left, right) => (left.base?.lineNumber ?? 0) - (right.base?.lineNumber ?? 0));
    added.sort((left, right) => (left[side]?.lineNumber ?? 0) - (right[side]?.lineNumber ?? 0));
    result.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const row of rows) {
    const cell = row[side];
    if (!cell) continue;
    if (cell.type === "remove") removed.push(row);
    else if (cell.type === "add") added.push(row);
    else {
      flush();
      result.push(row);
    }
  }
  flush();
  return result;
}
