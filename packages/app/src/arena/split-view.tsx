import { useCallback, useMemo, useState } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@getpaseo/highlight";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { tint } from "@/styles/tint";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { tokenizeToLines } from "@/utils/highlight-cache";
import { baseReadNote, fileLines, type CombinedDiff } from "./combined-diff";
import { syntaxExtension, tokensSpelling } from "./combined-tokens";
import { MAX_RENDERED_ROWS, diffRowHeight, diffTextHeight } from "./diff-metrics";
import {
  buildSplitBlocks,
  buildSplitRows,
  type SplitBlock,
  type SplitCell,
  type SplitRow,
} from "./split-rows";
import { ExpandBand, SegmentText } from "./three-way-file-diff";
import { TokenText } from "./token-text";

const NO_REVEALS: ReadonlySet<number> = new Set<number>();

// Same web-only sticky header pattern as the three-column viewer.
const STICKY_HEADER_STYLE = isWeb
  ? ({ position: "sticky", top: 0, zIndex: 1 } as unknown as ViewStyle)
  : null;

type Side = "a" | "b";

// Every row past the cap is dropped from the tail; the reader can ask for the rest.
function limitBlocks(blocks: readonly SplitBlock[], maxRows: number) {
  const limited: SplitBlock[] = [];
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

// Each side's file tokenized whole, read by line number and checked against the
// cell's text; a removed line still sits in the other side's file, so a removed
// cell reads that side's colours.
function useSideTokens(syntax: { path: string; aText: string; bText: string } | undefined) {
  return useMemo(() => {
    const ext = syntax ? syntaxExtension(syntax.path) : null;
    if (!syntax || !ext) return null;
    return {
      a: tokenizeToLines(fileLines(syntax.aText).join("\n"), ext),
      b: tokenizeToLines(fileLines(syntax.bText).join("\n"), ext),
    };
  }, [syntax]);
}

type SideTokens = { a: HighlightToken[][] | null; b: HighlightToken[][] | null } | null;

function cellTokens(
  tokens: SideTokens,
  cell: SplitCell,
  side: Side,
  row: SplitRow,
): HighlightToken[] | undefined {
  if (!tokens || cell.kind === "empty") return undefined;
  if (cell.kind === "removed") {
    // The line lives in the other side's file, at that side's number.
    const other = side === "a" ? row.b : row.a;
    const otherTokens = side === "a" ? tokens.b : tokens.a;
    if (other.kind === "empty" || other.lineNumber === null) return undefined;
    return tokensSpelling(otherTokens?.[other.lineNumber - 1], cell.content);
  }
  if (cell.lineNumber === null) return undefined;
  const own = side === "a" ? tokens.a : tokens.b;
  return tokensSpelling(own?.[cell.lineNumber - 1], cell.content);
}

// What the gutter says: the side's own line number, a minus for a dropped
// line, nothing for a cell facing the other side's line.
function gutterLabel(cell: SplitCell): string {
  if (cell.kind === "empty") return "";
  if (cell.kind === "removed") return "−";
  return cell.lineNumber === null ? "" : String(cell.lineNumber);
}

function cellStyle(cell: SplitCell, side: Side) {
  if (cell.kind === "changed") return side === "a" ? styles.cellA : styles.cellB;
  if (cell.kind === "both") return styles.cellBoth;
  if (cell.kind === "removed") return styles.cellRemoved;
  if (cell.kind === "empty") return styles.cellEmpty;
  return null;
}

function highlightFor(side: Side): StyleProp<TextStyle> {
  return side === "a" ? styles.highlightA : styles.highlightB;
}

function CellText({
  cell,
  side,
  tokens,
}: {
  cell: SplitCell;
  side: Side;
  tokens: HighlightToken[] | undefined;
}) {
  if (cell.kind === "empty") return <Text style={styles.lineText}> </Text>;
  const textStyle = cell.kind === "removed" ? styles.removedText : styles.text;
  if (tokens) {
    return (
      <TokenText
        tokens={tokens}
        segments={cell.kind === "changed" ? cell.segments : undefined}
        lineStyle={[styles.lineText, cell.kind === "removed" && styles.struck]}
        highlightStyle={highlightFor(side)}
      />
    );
  }
  if (cell.kind === "changed" && cell.segments) {
    return (
      <SegmentText
        segments={cell.segments}
        textStyle={textStyle}
        highlightStyle={highlightFor(side)}
      />
    );
  }
  return (
    <Text style={[styles.lineText, textStyle, cell.kind === "removed" && styles.struck]}>
      {cell.content || " "}
    </Text>
  );
}

// A plain overflow View per column, not a ScrollView, so a vertical wheel over
// a column still reaches the outer scroller (see CandidateColumn in the three
// columns). Each column scrolls sideways on its own; rows stay aligned because
// every row is one line high.
function Column({
  rows,
  side,
  tokens,
}: {
  rows: readonly SplitRow[];
  side: Side;
  tokens: SideTokens;
}) {
  return (
    <View style={[styles.column, side === "b" && styles.columnB]}>
      <View style={styles.gutterColumn}>
        {rows.map((row) => {
          const cell = row[side];
          const both =
            cell.kind === "both" || (row.a.kind === "removed" && row.b.kind === "removed");
          const sharedLabel =
            cell.kind === "removed" ? "Removed by both agents" : "Added by both agents";
          return (
            <View key={row.key} style={[styles.gutterCell, cellStyle(cell, side)]}>
              <Text style={styles.gutterNumber}>{gutterLabel(cell)}</Text>
              <Text
                style={styles.bothMarker}
                numberOfLines={1}
                accessibilityLabel={both ? sharedLabel : undefined}
              >
                {both ? "Both" : ""}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={styles.columnScroll}>
        {rows.map((row) => {
          const cell = row[side];
          return (
            <View key={row.key} style={[styles.cell, cellStyle(cell, side)]}>
              <CellText cell={cell} side={side} tokens={cellTokens(tokens, cell, side, row)} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The side-by-side view: A's result on the left, B's on the right, from the
 * same rows the one-column view reads. Each column marks the lines its side
 * wrote in that side's colour, strikes the lines it dropped, and leaves the
 * unchanged lines plain; where the two wrote different versions the lines
 * face each other with the words that differ marked.
 */
export function SplitFileView({
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
  syntax?: { path: string; aText: string; bText: string };
  maxHeight?: number;
  testID?: string;
}) {
  const capStyle = useMemo(
    () => (maxHeight ? inlineUnistylesStyle({ maxHeight }) : null),
    [maxHeight],
  );
  const rows = useMemo(() => buildSplitRows(diff), [diff]);
  const tokens = useSideTokens(syntax);
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
  const { blocks, truncated } = useMemo(() => {
    const folded = buildSplitBlocks(rows, revealed);
    return full ? { blocks: folded, truncated: false } : limitBlocks(folded, MAX_RENDERED_ROWS);
  }, [full, revealed, rows]);

  const baseNote = baseReadNote(diff);
  return (
    <View style={[styles.viewer, capStyle]} testID={testID}>
      {diff.mode === "direct" ? (
        <Text style={[styles.note, styles.pad]} testID="arena-combined-direct-note">
          {`Both rewrote this file, so it reads as ${labelA} against ${labelB}; the original is not in this view.`}
        </Text>
      ) : null}
      {baseNote ? (
        <Text style={[styles.note, styles.pad]} testID="arena-combined-base-note">
          {baseNote}
        </Text>
      ) : null}
      <View style={[styles.header, STICKY_HEADER_STYLE]}>
        <View style={styles.headerCell}>
          <View style={[styles.dot, styles.dotA]} />
          <Text style={[styles.headerText, styles.headerA]}>{labelA}</Text>
        </View>
        <View style={[styles.headerCell, styles.headerCellB]}>
          <View style={[styles.dot, styles.dotB]} />
          <Text style={[styles.headerText, styles.headerB]}>{labelB}</Text>
        </View>
      </View>
      <View style={styles.scroll}>
        {blocks.map((block) =>
          block.kind === "gap" ? (
            <ExpandBand key={block.key} gap={block} onReveal={handleReveal} />
          ) : (
            <View key={block.key} style={styles.pair}>
              <Column rows={block.rows} side="a" tokens={tokens} />
              <Column rows={block.rows} side="b" tokens={tokens} />
            </View>
          ),
        )}
      </View>
      {truncated ? (
        <View style={styles.pad}>
          <Button size="xs" variant="ghost" onPress={showAll}>
            {`This file changed too much to show at once — show all ${rows.length} rows`}
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

const GUTTER_WIDTH = 80;

const styles = StyleSheet.create((theme) => ({
  viewer: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    ...(isWeb ? { overflowY: "auto" as const } : { overflow: "hidden" as const }),
  },
  scroll: {
    paddingBottom: theme.spacing[3],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerCell: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    minHeight: diffRowHeight(theme) + 6,
  },
  headerCellB: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  headerA: {
    color: theme.colors.statusDotRunning,
  },
  headerB: {
    color: theme.colors.statusDotWarning,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotA: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  dotB: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  pair: {
    flexDirection: "row",
  },
  column: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
  },
  columnB: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  gutterColumn: {
    flexShrink: 0,
  },
  gutterCell: {
    width: GUTTER_WIDTH,
    minHeight: diffRowHeight(theme),
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  gutterNumber: {
    flex: 1,
    textAlign: "right",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
  },
  bothMarker: {
    width: Math.ceil(theme.fontSize.xs * 3.5),
    flexShrink: 0,
    marginLeft: theme.spacing[1],
    textAlign: "center",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.statusMerged,
    fontWeight: theme.fontWeight.medium,
  },
  columnScroll: {
    flex: 1,
    minWidth: 0,
    ...(isWeb ? { overflowX: "auto" as const } : null),
  },
  cell: {
    minHeight: diffRowHeight(theme),
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  // The side's own colour on the lines it wrote (docs/design.md §13).
  cellA: {
    backgroundColor: tint(theme.colors.statusDotRunning, 16),
  },
  cellB: {
    backgroundColor: tint(theme.colors.statusDotWarning, 18),
  },
  // A line both wrote, in both columns (combined-view.tsx `rowBoth`).
  cellBoth: {
    backgroundColor: tint(theme.colors.statusMerged, 14),
  },
  cellRemoved: {
    backgroundColor: tint(theme.colors.diffDeletion, 14),
  },
  cellEmpty: {
    backgroundColor: theme.colors.surface1,
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
  removedText: {
    color: theme.colors.foregroundMuted,
  },
  struck: {
    textDecorationLine: "line-through",
    color: theme.colors.foregroundMuted,
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
  pad: {
    padding: theme.spacing[2],
  },
  warning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
