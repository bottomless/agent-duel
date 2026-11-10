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
        <View key={row.aspect} style={styles.row}>
          <InlineText text={row.aspect} style={styles.aspect} />
          <InlineText text={side === "a" ? row.a : row.b} style={styles.value} />
        </View>
      ))}
    </View>
  );
}

/**
 * The summary under the two answers: Agent A's part under Agent A, Agent B's under Agent B, each
 * compared aspect a row level with the same row on the other side. A sentence about both sits
 * above the columns.
 */
export function SummaryColumnsView({ columns }: { columns: SummaryColumns }) {
  const { width, onLayout } = useContainerWidth();
  const stacked = width > 0 && width < STACKED_BREAKPOINT;
  return (
    <View style={styles.root} onLayout={onLayout} testID="arena-summary-columns">
      {columns.shared ? <InlineText text={columns.shared} style={styles.shared} /> : null}
      <View style={[styles.columns, stacked && styles.columnsStacked]}>
        <SideColumn side="a" sentence={columns.a} rows={columns.rows} />
        <SideColumn side="b" sentence={columns.b} rows={columns.rows} />
      </View>
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
  // The answers' own gutter, so each column sits under its answer.
  columns: {
    flexDirection: "row",
    columnGap: theme.spacing[8] + theme.spacing[2],
  },
  columnsStacked: {
    flexDirection: "column",
    rowGap: theme.spacing[6],
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
    marginTop: theme.spacing[3],
    paddingTop: theme.spacing[2] + theme.spacing[0.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
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
