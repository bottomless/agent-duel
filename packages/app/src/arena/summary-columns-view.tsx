import { createContext, Fragment, useContext, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useContainerWidth } from "@/hooks/use-container-width";
import { LIVE_SUMMARY_STACKED_BREAKPOINT, summaryColumnsStacked } from "./battle-layout";
import type { SummaryColumns } from "./summary-columns";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

/**
 * The summary width below which it stacks, set by the battle around it so the summary stacks with
 * its answers (`SHOWN_SUMMARY_STACKED_BREAKPOINT` for a shown battle).
 */
export const SummaryStackedBreakpoint = createContext(LIVE_SUMMARY_STACKED_BREAKPOINT);

/**
 * Inline code and bold, the only markdown the judge puts inside a sentence or a table cell. Code
 * is set a pixel under its text, which mono's wider glyphs need to sit level with it, on the chat's
 * code chip.
 */
function InlineText({
  text,
  style,
  codeStyle,
}: {
  text: string;
  style: object;
  codeStyle: object;
}) {
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
            // Without the code-surface marker the app-wide interface font replaces mono on web.
            <Text key={id} dataSet={CODE_SURFACE_DATASET} style={[styles.code, codeStyle]}>
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
      <InlineText text={sentence} style={styles.sentence} codeStyle={styles.sentenceCode} />
      {rows.map((row) => (
        <View key={row.aspect} style={[styles.row, styles.stackedRow]}>
          <InlineText text={row.aspect} style={styles.aspect} codeStyle={styles.aspectCode} />
          <InlineText
            text={side === "a" ? row.a : row.b}
            style={styles.value}
            codeStyle={styles.valueCode}
          />
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
          <InlineText text={columns.a} style={styles.sentence} codeStyle={styles.sentenceCode} />
        </View>
        <View style={[styles.cell, styles.sentenceCell]} testID="arena-summary-column-b">
          <InlineText text={columns.b} style={styles.sentence} codeStyle={styles.sentenceCode} />
        </View>
      </View>
      {columns.rows.map((row) => (
        <View key={row.aspect} style={[styles.pair, styles.rowPair]}>
          <View style={[styles.cell, styles.row]}>
            <InlineText text={row.aspect} style={styles.aspect} codeStyle={styles.aspectCode} />
            <InlineText text={row.a} style={styles.value} codeStyle={styles.valueCode} />
          </View>
          <View style={[styles.cell, styles.row]}>
            <InlineText text={row.aspect} style={styles.aspect} codeStyle={styles.aspectCode} />
            <InlineText text={row.b} style={styles.value} codeStyle={styles.valueCode} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The summary under the two answers: Agent A's part under Agent A, Agent B's under Agent B, each
 * compared aspect a row level with the same row on the other side. A sentence about both sits
 * above the columns. Each row is one cell, its aspect above its value, so a column as narrow as its
 * answer still reads. It stacks A's part above B's exactly when the answers stack.
 */
export function SummaryColumnsView({ columns }: { columns: SummaryColumns }) {
  const { width, onLayout } = useContainerWidth();
  const stacked = summaryColumnsStacked(width, useContext(SummaryStackedBreakpoint));
  return (
    <View style={styles.root} onLayout={onLayout} testID="arena-summary-columns">
      {columns.shared ? (
        <InlineText text={columns.shared} style={styles.shared} codeStyle={styles.sharedCode} />
      ) : null}
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
  // Rows of the comparison, each set off by a hairline so the two sides read across. The aspect
  // sits above its value in the same cell: beside it, a fixed label column left a narrow answer's
  // value a few words wide.
  row: {
    flexDirection: "column",
    gap: theme.spacing[0.5],
    paddingTop: theme.spacing[2] + theme.spacing[0.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  stackedRow: {
    marginTop: theme.spacing[3],
  },
  aspect: {
    color: theme.colors.foregroundMuted,
    fontSize: Math.round((theme.fontSize.base * 13) / 14),
    lineHeight: 20,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  // The chat's inline code chip (the markdown renderer's `code`), so a file or symbol name reads
  // as code here too rather than as text that shrank mid-sentence.
  code: {
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  sentenceCode: {
    fontSize: theme.fontSize.content - 1,
  },
  // A row's label stays muted, its code included, so the label does not outweigh its value.
  aspectCode: {
    fontSize: Math.round((theme.fontSize.base * 13) / 14) - 1,
    color: theme.colors.foregroundMuted,
  },
  valueCode: {
    fontSize: theme.fontSize.base - 1,
  },
  sharedCode: {
    fontSize: theme.fontSize.base - 1,
  },
  strong: {
    fontWeight: theme.fontWeight.semibold,
  },
}));
