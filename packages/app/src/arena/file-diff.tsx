import type { CombinedDiff } from "./combined-diff";
import { CombinedFileView } from "./combined-view";
import type { ArenaDiffLayout } from "./diff-layout";
import { SplitFileView } from "./split-view";

/**
 * A file's diff in the layout the reader has: A beside B, or one column. Both
 * read the same rows, so switching costs no work and changes no answer.
 */
export function ArenaFileDiff({
  diff,
  layout,
  labelA,
  labelB,
  syntax,
  maxHeight,
  testID,
}: {
  diff: CombinedDiff;
  layout: ArenaDiffLayout;
  labelA: string;
  labelB: string;
  syntax?: { path: string; aText: string; bText: string };
  maxHeight?: number;
  testID?: string;
}) {
  if (layout === "split") {
    return (
      <SplitFileView
        diff={diff}
        labelA={labelA}
        labelB={labelB}
        syntax={syntax}
        maxHeight={maxHeight}
        testID={testID}
      />
    );
  }
  return (
    <CombinedFileView
      diff={diff}
      labelA={labelA}
      labelB={labelB}
      syntax={syntax}
      maxHeight={maxHeight}
      testID={testID}
    />
  );
}
