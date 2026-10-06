import { useMemo } from "react";
import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaChangesRow } from "./changes-rows";
import type { ArenaDiffLayout } from "./diff-layout";
import { BaseRelativeFileView } from "./base-relative-view";

/** The row to open first: the first file the two sides disagree on, else the first. */
export function defaultChangesFile(rows: readonly ArenaChangesRow[]): string | null {
  return (rows.find((row) => row.status === "diverging") ?? rows[0])?.file ?? null;
}

/**
 * The selected file's diff inside the card, A beside B or as one column. A
 * file both changed the same way reads as the change both made, against the
 * base. A file without retained textual content says why it cannot be compared.
 */
export function InlineFileDiff({
  diff,
  file,
  layout,
}: {
  diff: ArenaComparisonDiff;
  file: string;
  layout: ArenaDiffLayout;
}) {
  const threeWay = useMemo(
    () => diff.files?.find((candidate) => candidate.file === file),
    [diff, file],
  );
  if (!threeWay) return null;
  return <BaseRelativeFileView key={`${diff.turnID}:${file}`} file={threeWay} layout={layout} />;
}
