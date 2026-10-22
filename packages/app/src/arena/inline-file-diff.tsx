import { useMemo } from "react";
import type { ArenaComparisonDiff, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaChangesRow } from "./changes-rows";
import type { ArenaDiffLayout } from "./diff-layout";
import { BaseRelativeFileView } from "./base-relative-view";

/** The row to open first: the first file the two sides disagree on, else the first. */
export function defaultChangesFile(rows: readonly ArenaChangesRow[]): string | null {
  return (rows.find((row) => row.status === "diverging") ?? rows[0])?.file ?? null;
}

/**
 * The files whose diffs are open, in the order the reader opened them. Undefined means the reader
 * has not chosen, so the default opens; empty means they closed every diff and nothing opens until
 * they pick a row. Chosen files the rows no longer hold drop out, and when none are left the
 * default opens again.
 */
export function openChangesFiles(
  rows: readonly ArenaChangesRow[],
  chosen: readonly string[] | undefined,
): readonly string[] {
  if (chosen?.length === 0) return chosen;
  const kept = chosen?.filter((file) => rows.some((row) => row.file === file)) ?? [];
  if (kept.length > 0) return kept;
  const fallback = defaultChangesFile(rows);
  return fallback ? [fallback] : [];
}

/** Opens a closed file's diff after the others, or closes an open one. */
export function toggleChangesFile(open: readonly string[], file: string): readonly string[] {
  return open.includes(file) ? open.filter((other) => other !== file) : [...open, file];
}

/**
 * One file's diff inside the card, A beside B or as one column. A file both
 * changed the same way reads as the change both made, against the base. A file
 * without retained textual content says why it cannot be compared. Embedded, it
 * sits under its row in the Changes list, which draws the edges around it.
 */
export function InlineFileDiff({
  diff,
  file,
  layout,
  waitingFor,
  embedded = false,
}: {
  diff: ArenaComparisonDiff;
  file: string;
  layout: ArenaDiffLayout;
  /** The side still working: its column is a placeholder until its result lands. */
  waitingFor?: ArenaSide;
  embedded?: boolean;
}) {
  const threeWay = useMemo(
    () => diff.files?.find((candidate) => candidate.file === file),
    [diff, file],
  );
  if (!threeWay) return null;
  return (
    <BaseRelativeFileView
      key={`${diff.turnID}:${file}`}
      file={threeWay}
      layout={layout}
      waitingFor={waitingFor}
      embedded={embedded}
    />
  );
}
