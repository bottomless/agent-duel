import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import type { ArenaChangesRow } from "./changes-rows";
import { divergenceStatusLabel } from "./divergence";

/**
 * The files a battle touched, one row each, with what A and B did to them.
 *
 * Pressing a row shows that file's diff under the list; the row is the only
 * control here. git's verdict and the per-side counts are words, not pills,
 * so nothing on the row reads as a tab. Hover follows docs/hover.md: a plain
 * View tracks the pointer, the Pressable inside it takes the press.
 */
export const ArenaChangesList = memo(function ArenaChangesList({
  rows,
  onSelect,
  selectedFile,
}: {
  rows: readonly ArenaChangesRow[];
  onSelect: (file: string) => void;
  /** The row the side panel is showing, when the list sits inside it. */
  selectedFile?: string;
}) {
  return (
    <View style={styles.list} testID="arena-changes-list">
      {rows.map((row) => (
        <ChangesRow
          key={row.file}
          row={row}
          onSelect={onSelect}
          selected={row.file === selectedFile}
        />
      ))}
    </View>
  );
});

function statusStyle(status: NonNullable<ArenaChangesRow["status"]>) {
  if (status === "identical") return styles.statusSame;
  if (status === "diverging") return styles.statusDiverging;
  return styles.statusMuted;
}

function ChangesRow({
  row,
  onSelect,
  selected,
}: {
  row: ArenaChangesRow;
  onSelect: (file: string) => void;
  selected: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onSelect(row.file), [onSelect, row.file]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        onPress={handlePress}
        style={[styles.row, hovered && styles.rowHovered, selected && styles.rowSelected]}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`Show the diff of ${row.file}`}
        testID={`arena-changes-row-${row.file}`}
      >
        <Text style={styles.file} numberOfLines={1}>
          {row.file}
        </Text>
        {row.status ? (
          <Text style={[styles.status, statusStyle(row.status)]}>
            {divergenceStatusLabel(row.status)}
          </Text>
        ) : null}
        <View style={styles.stats}>
          <SideStat side="a" row={row} />
          <SideStat side="b" row={row} />
        </View>
      </Pressable>
    </View>
  );
}

function SideStat({ side, row }: { side: "a" | "b"; row: ArenaChangesRow }) {
  const changed = row.changedBy === "both" || row.changedBy === side;
  const additions = side === "a" ? row.additionsA : row.additionsB;
  const deletions = side === "a" ? row.deletionsA : row.deletionsB;
  let stat: ReactNode;
  if (!changed) {
    stat = <Text style={styles.untouched}>unchanged</Text>;
  } else if (row.binary) {
    stat = <Text style={styles.untouched}>binary</Text>;
  } else {
    stat = <DiffStat additions={additions} deletions={deletions} />;
  }
  return (
    <View style={styles.sideStat}>
      <Text style={styles.sideLabel}>{side.toUpperCase()}</Text>
      {stat}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    minHeight: 36,
    flexDirection: "row",
    // In a narrow side panel the stats drop under the name rather than
    // squeezing it out; the name is what the row is for.
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  file: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 120,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
  status: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  statusSame: {
    color: theme.colors.statusSuccess,
  },
  statusDiverging: {
    color: theme.colors.statusDanger,
  },
  statusMuted: {
    color: theme.colors.foregroundMuted,
  },
  stats: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 0,
  },
  sideStat: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Both columns hold the widest stat so the rows line up on one rail.
    minWidth: 92,
  },
  sideLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    minWidth: 12,
  },
  untouched: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
