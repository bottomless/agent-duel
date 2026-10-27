import { Fragment, memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ArenaChangesRow } from "./changes-rows";
import { divergenceStatusLabel } from "./divergence";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Rows shown before the rest wait behind "Show more". A battle that touched hundreds of files
 * otherwise grows the list past the screen and pushes both agents' messages away. The list does
 * not scroll inside itself, because the diffs it holds scroll inside themselves. An open row
 * past these, such as a default file deep in the list, shows after them on its own rather than
 * pulling in every row above it.
 */
const VISIBLE_ROWS = 8;

/**
 * The files a battle touched, one row each, with what A and B did to them.
 *
 * Pressing a row opens that file's diff right under it, and pressing it again
 * closes it, the way a file header toggles its diff in a code review; several
 * can be open at once, and the chevron says which state each row is in. The
 * open row is the diff's header, so the diff carries no close control of its
 * own. git's verdict and the per-side counts are words, not pills, so nothing
 * on the row reads as a tab. Hover follows docs/hover.md: a plain View tracks
 * the pointer, the Pressable inside it takes the press.
 */
export const ArenaChangesList = memo(function ArenaChangesList({
  rows,
  openFiles,
  waitingFor,
  onToggle,
  renderDiff,
}: {
  rows: readonly ArenaChangesRow[];
  /** The rows whose diffs are open. */
  openFiles: readonly string[];
  /** The side still working: its counts say so, and no verdict on a pair that is not in yet. */
  waitingFor?: ArenaSide;
  /** Opens a closed row's diff or closes an open one. */
  onToggle: (file: string) => void;
  /** The diff that opens under a row. */
  renderDiff: (file: string) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  // Rows past the first ones that have been open while the rest were hidden. Closing one leaves
  // it where it is, so the row the reader just pressed does not vanish from under the pointer.
  const [kept, setKept] = useState<readonly string[]>([]);
  const toggleShowAll = useCallback(() => {
    setShowAll((shown) => !shown);
    setKept([]);
  }, []);
  const beyond = showAll ? [] : rows.slice(VISIBLE_ROWS);
  const newlyOpen = beyond
    .filter((row) => openFiles.includes(row.file) && !kept.includes(row.file))
    .map((row) => row.file);
  if (newlyOpen.length > 0) setKept([...kept, ...newlyOpen]);
  const pinned = beyond.filter((row) => openFiles.includes(row.file) || kept.includes(row.file));
  const visible = showAll ? rows : [...rows.slice(0, VISIBLE_ROWS), ...pinned];
  const hidden = rows.length - visible.length;
  const footer = hidden > 0 || (showAll && rows.length > VISIBLE_ROWS);
  return (
    <View style={styles.list} testID="arena-changes-list">
      {visible.map((row, index) => {
        const open = openFiles.includes(row.file);
        const lastItem = index === visible.length - 1 && !footer;
        return (
          <Fragment key={row.file}>
            <ChangesRow row={row} waitingFor={waitingFor} onToggle={onToggle} open={open} />
            {open ? (
              <View
                style={[styles.diffBand, lastItem && styles.diffBandLast]}
                testID={`arena-changes-diff-${row.file}`}
              >
                {renderDiff(row.file)}
              </View>
            ) : null}
          </Fragment>
        );
      })}
      {footer ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={hidden > 0 ? ChevronDown : ChevronUp}
          onPress={toggleShowAll}
          style={styles.more}
          testID="arena-changes-more"
        >
          {hidden > 0
            ? `Show ${hidden} more ${hidden === 1 ? "file" : "files"}`
            : "Show fewer files"}
        </Button>
      ) : null}
    </View>
  );
});

function statusStyle(status: ArenaChangesRow["status"]) {
  if (status === "identical") return styles.statusSame;
  if (status === "diverging") return styles.statusDiverging;
  return styles.statusMuted;
}

function ChangesRow({
  row,
  waitingFor,
  onToggle,
  open,
}: {
  row: ArenaChangesRow;
  waitingFor: ArenaSide | undefined;
  onToggle: (file: string) => void;
  open: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onToggle(row.file), [onToggle, row.file]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        onPress={handlePress}
        style={[styles.row, hovered && styles.rowHovered, open && styles.rowOpen]}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`${open ? "Hide" : "Show"} the diff of ${row.file}`}
        testID={`arena-changes-row-${row.file}`}
      >
        {open ? (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        )}
        <Text style={styles.file} numberOfLines={1}>
          {row.file}
        </Text>
        {waitingFor ? null : (
          <Text style={[styles.status, statusStyle(row.status)]}>
            {divergenceStatusLabel(row.status)}
          </Text>
        )}
        <View style={styles.stats}>
          <SideStat side="a" row={row} waiting={waitingFor === "a"} />
          <SideStat side="b" row={row} waiting={waitingFor === "b"} />
        </View>
      </Pressable>
    </View>
  );
}

function SideStat({
  side,
  row,
  waiting,
}: {
  side: "a" | "b";
  row: ArenaChangesRow;
  /** The side is still working, so it has no counts yet. */
  waiting: boolean;
}) {
  const changed = row.changedBy === "both" || row.changedBy === side;
  const additions = side === "a" ? row.additionsA : row.additionsB;
  const deletions = side === "a" ? row.deletionsA : row.deletionsB;
  let stat: ReactNode;
  if (waiting) {
    stat = <Text style={styles.waiting}>working</Text>;
  } else if (!changed) {
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
  // An open diff is a band between its row and the next, one hairline above and below.
  diffBand: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  // The list's own border already closes the last band.
  diffBandLast: {
    borderBottomWidth: 0,
  },
  // The button's padding matches the rows', so its chevron sits on the rows' chevron rail.
  more: {
    alignSelf: "flex-start",
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
  rowOpen: {
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
  waiting: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
}));
