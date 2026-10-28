import { useCallback, useMemo, useState } from "react";
import { Text, View, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { tint } from "@/styles/tint";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  baseReadNote,
  buildCombinedBlocks,
  type CombinedBlock,
  type CombinedDiff,
} from "./combined-diff";
import {
  attachCombinedTokens,
  syntaxExtension,
  type CombinedLineWithTokens as CombinedLine,
  type CombinedRowWithTokens as CombinedRow,
} from "./combined-tokens";
import { MAX_RENDERED_ROWS, diffRowHeight, diffTextHeight } from "./diff-metrics";
import { ExpandBand, SegmentText } from "./three-way-file-diff";
import { TokenText } from "./token-text";

const NO_REVEALS: ReadonlySet<number> = new Set<number>();

type CombinedBlockWithTokens =
  | { kind: "rows"; key: string; rows: CombinedRow[] }
  | Exclude<CombinedBlock, { kind: "rows" }>;

// Every row past the cap is dropped from the tail, so a rewrite does not stall
// the tab; the reader can ask for the rest.
function limitBlocks(blocks: readonly CombinedBlockWithTokens[], maxRows: number) {
  const limited: CombinedBlockWithTokens[] = [];
  let used = 0;
  for (const block of blocks) {
    if (block.kind !== "rows") {
      limited.push(block);
      continue;
    }
    if (used + block.rows.length <= maxRows) {
      limited.push(block);
      used += block.rows.length;
      continue;
    }
    const remaining = maxRows - used;
    if (remaining > 0) limited.push({ ...block, rows: block.rows.slice(0, remaining) });
    return { blocks: limited, truncated: true };
  }
  return { blocks: limited, truncated: false };
}

// Name shared changes explicitly so their colour needs no separate legend.
function sideLabel(tone: Tone): string {
  if (tone === "a") return "A";
  if (tone === "b") return "B";
  if (tone === "both") return "Both";
  return "";
}

function Gutter({ line, change, tone }: { line: CombinedLine; change: Change; tone: Tone }) {
  const label = sideLabel(tone);
  return (
    <View style={[styles.gutter, gutterChangeStyle(change, tone)]}>
      <Text style={styles.gutterNumber}>{line.lineA ?? ""}</Text>
      <Text style={styles.gutterNumber}>{line.lineB ?? ""}</Text>
      <Text style={[styles.marker, markerToneStyle(tone)]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// The row's colour says whose line it is: A's lines in A's colour, B's in B's,
// a line both wrote in the merged colour labelled Both, a dropped line
// red with the letter of the side that dropped it, the base grey. The
// question the voter asks is "what did A do, what did B do", and the row
// answers it before the gutter is read.
type Tone = "shared" | "a" | "b" | "both" | "base";
type Change = "none" | "add" | "remove";

function rowChangeStyle(change: Change, tone: Tone) {
  if (change === "remove") return styles.rowRemove;
  if (change === "add") {
    if (tone === "a") return styles.rowA;
    if (tone === "b") return styles.rowB;
    return styles.rowBoth;
  }
  if (tone === "base") return styles.rowBase;
  return null;
}

function gutterChangeStyle(change: Change, tone: Tone) {
  if (change === "remove") return styles.gutterRemove;
  if (change === "add") {
    if (tone === "a") return styles.gutterA;
    if (tone === "b") return styles.gutterB;
    return styles.gutterBoth;
  }
  return null;
}

function markerToneStyle(tone: Tone) {
  if (tone === "a") return styles.markerA;
  if (tone === "b") return styles.markerB;
  if (tone === "both") return styles.markerBoth;
  return null;
}

function highlightFor(tone: Tone): StyleProp<TextStyle> {
  return tone === "a" ? styles.highlightA : styles.highlightB;
}

// Syntax colours when the highlighter knows the language, the change colour
// otherwise; the words that differ are marked on top of either.
function LineContent({
  line,
  tone,
  textStyle,
}: {
  line: CombinedLine;
  tone: Tone;
  textStyle: StyleProp<TextStyle>;
}) {
  if (line.tokens) {
    return (
      <TokenText
        tokens={line.tokens}
        segments={line.segments}
        lineStyle={styles.lineText}
        highlightStyle={highlightFor(tone)}
      />
    );
  }
  if (line.segments) {
    return (
      <SegmentText
        segments={line.segments}
        textStyle={textStyle}
        highlightStyle={highlightFor(tone)}
      />
    );
  }
  return <Text style={[styles.lineText, textStyle]}>{line.content || " "}</Text>;
}

function textStyleFor(change: Change, muted: boolean | undefined) {
  if (change === "remove") return styles.removeText;
  return muted ? styles.mutedText : styles.text;
}

function LineRow({
  line,
  tone,
  change,
  muted,
}: {
  line: CombinedLine;
  tone: Tone;
  change: Change;
  muted?: boolean;
}) {
  const textStyle = textStyleFor(change, muted);
  return (
    <View style={[styles.row, rowChangeStyle(change, tone)]}>
      <Gutter line={line} change={change} tone={tone} />
      <View style={styles.cell}>
        <LineContent line={line} tone={tone} textStyle={textStyle} />
      </View>
    </View>
  );
}

function ConflictRow({
  row,
  labelA,
  labelB,
}: {
  row: Extract<CombinedRow, { kind: "conflict" }>;
  labelA: string;
  labelB: string;
}) {
  return (
    <View style={styles.conflict} testID="arena-combined-conflict">
      <View style={[styles.caption, styles.captionA]}>
        <Text style={styles.captionText}>{`${labelA}'s version`}</Text>
      </View>
      {row.a.length === 0 ? <EmptyVersion /> : null}
      {row.a.map((line) => (
        <LineRow key={line.key} line={line} tone="a" change="add" />
      ))}
      {row.base.length > 0 ? (
        <>
          <View style={[styles.caption, styles.captionBase]}>
            <Text style={styles.captionMutedText}>base</Text>
          </View>
          {row.base.map((line) => (
            <LineRow key={line.key} line={line} tone="base" change="none" muted />
          ))}
        </>
      ) : null}
      <View style={[styles.caption, styles.captionB]}>
        <Text style={styles.captionText}>{`${labelB}'s version`}</Text>
      </View>
      {row.b.length === 0 ? <EmptyVersion /> : null}
      {row.b.map((line) => (
        <LineRow key={line.key} line={line} tone="b" change="add" />
      ))}
    </View>
  );
}

function EmptyVersion() {
  return (
    <View style={styles.row}>
      <Text style={[styles.lineText, styles.mutedText, styles.emptyVersion]}>(removed)</Text>
    </View>
  );
}

function Row({ row, labelA, labelB }: { row: CombinedRow; labelA: string; labelB: string }) {
  switch (row.kind) {
    case "shared":
      return row.origin === "both" ? (
        <LineRow line={row.line} tone="both" change="add" />
      ) : (
        <LineRow line={row.line} tone="shared" change="none" />
      );
    case "added":
      return <LineRow line={row.line} tone={row.side} change="add" />;
    case "removed":
      return <LineRow line={row.line} tone={row.side} change="remove" />;
    case "conflict":
      return <ConflictRow row={row} labelA={labelA} labelB={labelB} />;
  }
}

/**
 * The one-column view: git's merge as the spine, each side's own lines in
 * that side's colour, conflicts as the two versions stacked over the base.
 * Reads at any width, which two columns do not.
 */
export function CombinedFileView({
  diff,
  labelA,
  labelB,
  syntax,
  maxHeight,
  testID,
}: {
  diff: CombinedDiff;
  labelA: string;
  labelB: string;
  /** The file's path and both sides' text, for syntax colours; omit for plain text. */
  syntax?: { path: string; aText: string; bText: string };
  /** Inside a card the viewer caps its height and scrolls; in a panel it fills. */
  maxHeight?: number;
  testID?: string;
}) {
  const capStyle = useMemo(
    () => (maxHeight ? inlineUnistylesStyle({ maxHeight }) : null),
    [maxHeight],
  );
  const rows = useMemo(
    () =>
      attachCombinedTokens(diff.rows, {
        aText: syntax?.aText ?? "",
        bText: syntax?.bText ?? "",
        ext: syntax ? syntaxExtension(syntax.path) : null,
      }),
    [diff.rows, syntax],
  );
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(NO_REVEALS);
  const [full, setFull] = useState(false);
  const handleReveal = useCallback((start: number, end: number) => {
    setRevealed((previous) => {
      const next = new Set(previous);
      for (let index = start; index < end; index += 1) next.add(index);
      return next;
    });
  }, []);
  const showAll = useCallback(() => setFull(true), []);
  const baseNote = baseReadNote(diff);
  const { blocks, truncated } = useMemo(() => {
    const folded = buildCombinedBlocks(rows, revealed) as CombinedBlockWithTokens[];
    return full ? { blocks: folded, truncated: false } : limitBlocks(folded, MAX_RENDERED_ROWS);
  }, [full, revealed, rows]);

  return (
    <View style={[styles.viewer, capStyle]} testID={testID}>
      {diff.mode === "direct" ? (
        <Text style={[styles.mutedText, styles.pad]} testID="arena-combined-direct-note">
          {`Both rewrote this file, so it reads as ${labelA} against ${labelB}; the original is not in this view.`}
        </Text>
      ) : null}
      {baseNote ? (
        <Text style={[styles.mutedText, styles.pad]} testID="arena-combined-base-note">
          {baseNote}
        </Text>
      ) : null}
      <View style={styles.scroll}>
        {blocks.map((block) =>
          block.kind === "gap" ? (
            <ExpandBand key={block.key} gap={block} onReveal={handleReveal} />
          ) : (
            <View key={block.key}>
              {block.rows.map((row) => (
                <Row key={row.key} row={row} labelA={labelA} labelB={labelB} />
              ))}
            </View>
          ),
        )}
      </View>
      {truncated ? (
        <View style={styles.pad}>
          <Button size="xs" variant="ghost" onPress={showAll}>
            {`This file changed too much to show at once — show all ${diff.rows.length} rows`}
          </Button>
        </View>
      ) : null}
      {diff.aligned ? null : (
        <Text style={[styles.warning, styles.pad]}>
          This file was too large to align line by line; it is shown as one side replaced in full.
        </Text>
      )}
    </View>
  );
}

const GUTTER_NUMBER_WIDTH = 34;
// Room for the shared-change label.

const styles = StyleSheet.create((theme) => ({
  viewer: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    // One scroller for the whole file, both directions; a plain overflow View so
    // the browser's scroll chaining still reaches the panel (see CandidateColumn).
    ...(isWeb
      ? { overflowX: "auto" as const, overflowY: "auto" as const }
      : { overflow: "hidden" as const }),
  },
  scroll: {
    minWidth: "100%",
    // The last line should not sit on the viewer's edge, or a scrolled view
    // reads as a cut-off one.
    paddingBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    minHeight: diffRowHeight(theme),
    alignItems: "center",
  },
  // Side colours from the status dots, blue for A and amber for B, at a tint
  // the code stays readable on; a dropped line keeps the deletion red
  // (docs/design.md §13).
  rowA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 16),
  },
  rowB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 18),
  },
  // A line both wrote: the merged token, the third answer to who did what,
  // so it is neither side's colour and not the base grey.
  rowBoth: {
    backgroundColor: tint(theme.colors.statusMerged, 14),
  },
  rowRemove: {
    backgroundColor: tint(theme.colors.diffDeletion, 14),
  },
  rowBase: {
    backgroundColor: theme.colors.surface1,
  },
  gutter: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  gutterA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 24),
  },
  gutterB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 26),
  },
  gutterBoth: {
    backgroundColor: tint(theme.colors.statusMerged, 22),
  },
  gutterRemove: {
    backgroundColor: tint(theme.colors.diffDeletion, 20),
  },
  gutterNumber: {
    width: GUTTER_NUMBER_WIDTH,
    textAlign: "right",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
  },
  marker: {
    width: Math.ceil(theme.fontSize.xs * 3.5),
    flexShrink: 0,
    marginLeft: theme.spacing[1],
    textAlign: "center",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: "transparent",
  },
  markerA: {
    color: theme.colors.statusDotRunning,
    fontWeight: theme.fontWeight.medium,
  },
  markerB: {
    color: theme.colors.statusDotWarning,
    fontWeight: theme.fontWeight.medium,
  },
  markerBoth: {
    color: theme.colors.statusMerged,
    fontWeight: theme.fontWeight.medium,
  },
  cell: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  lineText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: diffTextHeight(theme),
    ...(isWeb ? { whiteSpace: "pre" as const, overflowWrap: "normal" as const } : null),
  },
  text: {
    color: theme.colors.foreground,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
  },
  removeText: {
    color: theme.colors.diffDeletion,
  },
  // The words that differ: the side's tint, and the foreground over it, since
  // a syntax colour on a tinted ground does not clear the dark theme.
  highlightA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 32),
    color: theme.colors.foreground,
  },
  highlightB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 34),
    color: theme.colors.foreground,
  },
  conflict: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  caption: {
    minHeight: diffRowHeight(theme),
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  captionA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 30),
  },
  captionB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 32),
  },
  captionBase: {
    backgroundColor: theme.colors.surface2,
  },
  captionText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  captionMutedText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  emptyVersion: {
    paddingHorizontal: theme.spacing[2],
  },
  pad: {
    padding: theme.spacing[2],
  },
  warning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
