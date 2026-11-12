import { Fragment, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useContainerWidth } from "@/hooks/use-container-width";
import type { SummaryColumns } from "./summary-columns";

// The same width at which the battle stacks its two answers (`battle-view.tsx`).
const STACKED_BREAKPOINT = 520;

/** Inline code and bold, the only markdown the judge puts inside a sentence or a table cell. */
function InlineText({ text, style }: { text: string; style: object }) {
  const parts = useMemo(
    () =>
      text
        .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
        .filter(Boolean)
        .map((part, position) => ({ id: `${position}:${part}`, part })),
    [text],
  );
  return (
    <Text style={style}>
      {parts.map(({ id, part }) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <Text key={id} style={styles.code}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <Text key={id} style={styles.strong}>
              {part.slice(2, -2)}
            </Text>
          );
        }
        return <Fragment key={id}>{part}</Fragment>;
      })}
    </Text>
  );
}

function SideColumn({
  side,
  sentence,
  rows,
}: {
  side: "a" | "b";
  sentence: string;
  rows: SummaryColumns["rows"];
}) {
  return (
    <View style={styles.column} testID={`arena-summary-column-${side}`}>
      <InlineText text={sentence} style={styles.sentence} />
      {rows.map((row) => (
        <View key={row.aspect} style={[styles.row, styles.stackedRow]}>
          <InlineText text={row.aspect} style={styles.aspect} />
          <InlineText text={side === "a" ? row.a : row.b} style={styles.value} />
        </View>
      ))}
    </View>
  );
}

/**
 * Side by side, the table is laid out a row at a time across both answers, so each pair of cells
 * shares one height: a longer sentence or value on one side pushes both sides' next row down
 * together, and each aspect stays level with the same aspect on the other side.
 */
function SideBySideRows({ columns }: { columns: SummaryColumns }) {
  return (
    <View testID="arena-summary-rows">
      <View style={styles.pair}>
        <View style={[styles.cell, styles.sentenceCell]} testID="arena-summary-column-a">
          <InlineText text={columns.a} style={styles.sentence} />
        </View>
        <View style={[styles.cell, styles.sentenceCell]} testID="arena-summary-column-b">
          <InlineText text={columns.b} style={styles.sentence} />
        </View>
      </View>
      {columns.rows.map((row) => (
        <View key={row.aspect} style={[styles.pair, styles.rowPair]}>
          <View style={[styles.cell, styles.row]}>
            <InlineText text={row.aspect} style={styles.aspect} />
            <InlineText text={row.a} style={styles.value} />
          </View>
          <View style={[styles.cell, styles.row]}>
            <InlineText text={row.aspect} style={styles.aspect} />
            <InlineText text={row.b} style={styles.value} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The summary under the two answers: Agent A's part under Agent A, Agent B's under Agent B, each
 * compared aspect a row level with the same row on the other side. A sentence about both sits
 * above the columns. Too narrow for two columns, A's part goes above B's.
 */
export function SummaryColumnsView({ columns }: { columns: SummaryColumns }) {
  const { width, onLayout } = useContainerWidth();
  const stacked = width > 0 && width < STACKED_BREAKPOINT;
  return (
    <View style={styles.root} onLayout={onLayout} testID="arena-summary-columns">
      {columns.shared ? <InlineText text={columns.shared} style={styles.shared} /> : null}
      {stacked ? (
        <View style={styles.columnsStacked}>
          <SideColumn side="a" sentence={columns.a} rows={columns.rows} />
          <SideColumn side="b" sentence={columns.b} rows={columns.rows} />
        </View>
      ) : (
        <SideBySideRows columns={columns} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[3],
  },
  shared: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  columnsStacked: {
    flexDirection: "column",
    rowGap: theme.spacing[6],
  },
  // One row of the table across both answers, at the answers' own gutter so each cell sits under
  // its answer. The cells stretch to the taller one, which carries both hairlines below level.
  pair: {
    flexDirection: "row",
    alignItems: "stretch",
    columnGap: theme.spacing[8] + theme.spacing[2],
  },
  rowPair: {
    marginTop: theme.spacing[3],
  },
  cell: {
    flex: 1,
    minWidth: 0,
  },
  sentenceCell: {
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Each column opens with a hairline, a quiet echo of the answer's colour rule above it.
  column: {
    flex: 1,
    minWidth: 0,
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sentence: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: 23,
  },
  // Rows of the comparison, each set off by a hairline so the two sides read across.
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[4],
    paddingTop: theme.spacing[2] + theme.spacing[0.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  stackedRow: {
    marginTop: theme.spacing[3],
  },
  aspect: {
    flexBasis: 150,
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: Math.round((theme.fontSize.base * 13) / 14),
    lineHeight: 20,
  },
  value: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  strong: {
    fontWeight: theme.fontWeight.semibold,
  },
}));
